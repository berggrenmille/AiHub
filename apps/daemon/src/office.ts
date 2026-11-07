import { createHash } from "node:crypto";
import type { ActivityKind, ChatMessage, ChatResponse, Run, RunKind, RunState, RuntimeStatus, StateSnapshot } from "@aihub/shared";
import { EventBus } from "./events.ts";
import { Gateway, type GatewayTool } from "./gateway/gateway.ts";
import { OFFICE_TOOLS } from "./gateway/tools.ts";
import { RunQueue } from "./queue.ts";
import { ContextUnavailableError, type AgentRuntime, type ContextOptions, type TurnResult } from "./runtime/types.ts";
import { CHIEF_OF_STAFF, CHIEF_OF_STAFF_CONVERSATION_ID } from "./staff/chief-of-staff.ts";
import type { ConversationRecord, Store } from "./store/store.ts";

export class NotFoundError extends Error {}

/** One background turn for an agent. */
export interface Task {
  agentId: string;
  kind: RunKind;
  title: string;
  /** Instructions for this kind of run, added to the agent's charter. */
  instructions: string;
  /** The assembled context: what the agent needs to know, built from records by code. */
  input: string;
  /** Use a run the caller already opened, such as a briefing that was collecting first. */
  runId?: string;
  timeoutMs?: number;
}

export interface TaskOutcome {
  run: Run;
  /** The agent's final message. */
  text: string;
}

export interface OfficeOptions {
  store: Store;
  runtime: AgentRuntime;
  tools?: GatewayTool[];
  queue?: RunQueue;
  /** How many earlier messages to replay when a chat's context has to be rebuilt. */
  historyLimit?: number;
  turnTimeoutMs?: number;
}

/**
 * The staff engine as far as Milestone 1 goes: the Chief of Staff chat on top of the store, the
 * runtime, the gateway, and the run queue. Every change is recorded first and then published.
 */
export class Office {
  readonly bus = new EventBus();
  readonly store: Store;
  readonly gateway: Gateway;
  readonly queue: RunQueue;
  private readonly runtime: AgentRuntime;
  private readonly historyLimit: number;
  private readonly turnTimeoutMs: number | undefined;
  /** Contexts started or resumed by this daemon process, so they need no resume before a turn. */
  private readonly liveContexts = new Set<string>();
  private runtimeStatus: RuntimeStatus | null = null;

  constructor(options: OfficeOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.queue = options.queue ?? new RunQueue();
    this.historyLimit = options.historyLimit ?? 20;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.gateway = new Gateway(this.store, options.tools ?? OFFICE_TOOLS, (entry) => this.bus.publish({ type: "activity", entry }));
  }

  /** Seeds the Chief of Staff and closes out runs that a restart interrupted. */
  start() {
    this.store.upsertAgent(CHIEF_OF_STAFF);
    this.store.ensureConversation({ id: CHIEF_OF_STAFF_CONVERSATION_ID, agentId: CHIEF_OF_STAFF.id, title: CHIEF_OF_STAFF.name });
    for (const run of this.store.failUnfinishedRuns("The daemon stopped before this run finished.")) {
      this.activity(run.agentId, run.id, "run_failed", `${run.title}: stopped by a daemon restart`);
    }
  }

  /** Asks the runtime who is signed in and publishes the answer. */
  async refreshRuntimeStatus(): Promise<RuntimeStatus> {
    let status: RuntimeStatus;
    try {
      status = await this.runtime.account();
    } catch (error) {
      status = { signedIn: false, detail: `Codex is unavailable: ${errorText(error)}` };
    }
    this.runtimeStatus = status;
    this.bus.publish({ type: "runtime", runtime: status });
    return status;
  }

  snapshot(): StateSnapshot {
    return {
      agents: this.store.listAgents(),
      conversations: this.store.listConversations(),
      messages: this.store.recentMessages(50),
      runs: this.store.recentRuns(30),
      activity: this.store.recentActivity(50),
      runtime: this.runtimeStatus,
      lastEventId: this.bus.lastEventId,
    };
  }

  /** Records the operator's message and queues the reply. Returns before the reply starts. */
  chat(conversationId: string, text: string): ChatResponse {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new NotFoundError(`No conversation ${conversationId}`);
    const run = this.store.createRun({ agentId: conversation.agentId, kind: "chat", title: "Reply in chat" });
    const message = this.store.addMessage({ conversationId, author: "operator", agentId: null, body: text, runId: run.id });
    this.bus.publish({ type: "message", message });
    this.publishRun(run);
    this.queue.enqueue("interactive", () => this.reply(run.id, conversation.id, message));
    return { message, run };
  }

  private async reply(runId: string, conversationId: string, message: ChatMessage) {
    const conversation = this.store.getConversation(conversationId)!;
    const agent = this.store.getAgentRecord(conversation.agentId)!;
    const caller = { agentId: agent.id, runId, profile: agent.profile };
    const options: ContextOptions = { profile: agent.profile, instructions: agent.charter, tools: this.gateway.specsFor(caller) };
    this.setRunState(runId, "working");
    this.activity(agent.id, runId, "run_started", `${agent.name} is replying in chat`);

    const turn = (contextId: string, input: string): Promise<TurnResult> =>
      this.runtime.runTurn(contextId, {
        input,
        timeoutMs: this.turnTimeoutMs,
        onToolCall: (call) => this.gateway.call(caller, call),
        onEvent: (event) => {
          if (event.type === "delta") this.bus.publish({ type: "delta", runId, conversationId, text: event.text });
          if (event.type === "blocked") this.activity(agent.id, runId, "blocked", `Blocked an attempt to ${event.what}`);
        },
      });

    try {
      let context = await this.openContext(conversation, options, message);
      let result: TurnResult;
      try {
        result = await turn(context.contextId, context.input);
      } catch (error) {
        // The runtime lost the thread mid-session, for example after a crash it could not resume.
        if (!(error instanceof ContextUnavailableError)) throw error;
        this.liveContexts.delete(context.contextId);
        context = await this.rebuildContext(conversation, options, message);
        result = await turn(context.contextId, context.input);
      }
      this.publishRun(this.store.addTurn(runId, result.usage));
      if (result.text) this.postMessage(conversationId, agent.id, result.text, runId);
      if (result.status === "completed") this.finish(runId, "done");
      else this.finish(runId, "failed", result.error ?? `The turn was ${result.status}`);
    } catch (error) {
      this.finish(runId, "failed", errorText(error));
    }
  }

  /**
   * Queues one background turn in a fresh, ephemeral context: background runs start from records
   * every time (DESIGN.md › Context assembly). Resolves when the run has ended, done or failed.
   */
  runTask(task: Task): Promise<TaskOutcome> {
    const agent = this.store.getAgentRecord(task.agentId);
    if (!agent) throw new NotFoundError(`No agent ${task.agentId}`);
    const run = task.runId ? this.store.getRun(task.runId)! : this.openRun(agent.id, task.kind, task.title);
    return new Promise((resolve, reject) =>
      this.queue.enqueue("background", () => this.executeTask(run.id, task).then(resolve, reject)),
    );
  }

  /** Records a new queued run. */
  openRun(agentId: string, kind: RunKind, title: string): Run {
    const run = this.store.createRun({ agentId, kind, title });
    this.publishRun(run);
    return run;
  }

  setRunState(runId: string, state: RunState, error?: string) {
    this.publishRun(this.store.setRunState(runId, state, error));
  }

  /** Posts an agent's message, such as a briefing, to a conversation. */
  postMessage(conversationId: string, agentId: string, body: string, runId: string | null): ChatMessage {
    const message = this.store.addMessage({ conversationId, author: "agent", agentId, body, runId });
    this.bus.publish({ type: "message", message });
    return message;
  }

  private async executeTask(runId: string, task: Task): Promise<TaskOutcome> {
    const agent = this.store.getAgentRecord(task.agentId)!;
    const caller = { agentId: agent.id, runId, profile: agent.profile };
    this.setRunState(runId, "working");
    this.activity(agent.id, runId, "run_started", `${agent.name}: ${task.title}`);
    let text = "";
    try {
      const contextId = await this.runtime.startContext({
        profile: agent.profile,
        instructions: `${agent.charter}

${task.instructions}`,
        tools: this.gateway.specsFor(caller),
        ephemeral: true,
      });
      const result = await this.runtime.runTurn(contextId, {
        input: task.input,
        timeoutMs: task.timeoutMs ?? this.turnTimeoutMs,
        onToolCall: (call) => this.gateway.call(caller, call),
        onEvent: (event) => {
          if (event.type === "blocked") this.activity(agent.id, runId, "blocked", `Blocked an attempt to ${event.what}`);
        },
      });
      this.publishRun(this.store.addTurn(runId, result.usage));
      text = result.text;
      if (result.status === "completed") this.finish(runId, "done");
      else this.finish(runId, "failed", result.error ?? `The turn was ${result.status}`);
    } catch (error) {
      this.finish(runId, "failed", errorText(error));
    }
    return { run: this.store.getRun(runId)!, text };
  }

  /**
   * Model threads are a cache (DESIGN.md › Context assembly). Resume the saved thread if it was
   * started with the same charter and tools; otherwise start a new one from the saved messages.
   */
  private async openContext(conversation: ConversationRecord, options: ContextOptions, message: ChatMessage) {
    const saved = conversation.contextFingerprint === fingerprintOf(options) ? conversation.contextId : null;
    if (saved && this.liveContexts.has(saved)) return { contextId: saved, input: message.body };
    if (saved) {
      try {
        await this.runtime.resumeContext(saved, options);
        this.liveContexts.add(saved);
        return { contextId: saved, input: message.body };
      } catch (error) {
        if (!(error instanceof ContextUnavailableError)) throw error;
      }
    }
    return this.rebuildContext(conversation, options, message);
  }

  private async rebuildContext(conversation: ConversationRecord, options: ContextOptions, message: ChatMessage) {
    const contextId = await this.runtime.startContext(options);
    this.store.setConversationContext(conversation.id, contextId, fingerprintOf(options));
    this.liveContexts.add(contextId);

    const history = this.store
      .recentMessages(this.historyLimit + 1, conversation.id)
      .filter((earlier) => earlier.id !== message.id)
      .slice(-this.historyLimit);
    if (history.length === 0) return { contextId, input: message.body };

    this.activity(conversation.agentId, message.runId, "context_rebuilt", `Restored the chat from ${history.length} saved messages`);
    const agentName = this.store.getAgentRecord(conversation.agentId)?.name ?? "Agent";
    const transcript = history
      .map((earlier) => `${earlier.author === "operator" ? "Operator" : agentName}: ${clip(earlier.body, 2000)}`)
      .join("\n\n");
    return {
      contextId,
      input: [
        "AiHub restored this conversation from its records. The earlier messages, oldest first:",
        "",
        transcript,
        "",
        "The operator's new message:",
        message.body,
      ].join("\n"),
    };
  }

  private finish(runId: string, state: "done" | "failed", error?: string) {
    this.setRunState(runId, state, error);
    const run = this.store.getRun(runId)!;
    const tokens = run.usage.inputTokens + run.usage.outputTokens;
    const summary =
      state === "done" ? `${run.title}: done, ${run.turns} turn${run.turns === 1 ? "" : "s"}, ${tokens} tokens` : `${run.title}: failed. ${error}`;
    this.activity(run.agentId, runId, state === "done" ? "run_finished" : "run_failed", summary);
  }

  private publishRun(run: Run) {
    this.bus.publish({ type: "run", run });
    const agent = this.store.getAgent(run.agentId);
    if (agent) this.bus.publish({ type: "agent", agent });
  }

  private activity(agentId: string | null, runId: string | null, kind: ActivityKind, summary: string) {
    this.bus.publish({ type: "activity", entry: this.store.addActivity({ agentId, runId, kind, summary }) });
  }
}

function fingerprintOf(options: ContextOptions): string {
  return createHash("sha256").update(JSON.stringify([options.profile, options.instructions, options.tools])).digest("hex");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
