import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActivityKind,
  Agent,
  ChatMessage,
  ChatResponse,
  Item,
  MessageKind,
  OfficeStats,
  Run,
  RunKind,
  Responsibility,
  RunState,
  RuntimeStatus,
  StaffProfile,
  StateSnapshot,
} from "@aihub/shared";
import { ConflictError, NotFoundError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { Gateway, type GatewayTool } from "./gateway/gateway.ts";
import { OFFICE_TOOLS } from "./gateway/tools.ts";
import { RunQueue } from "./queue.ts";
import { ContextUnavailableError, type AgentRuntime, type ContextOptions, type TurnResult } from "./runtime/types.ts";
import { DAILY_TURN_LIMIT, SUPERVISOR_LIMIT } from "./limits.ts";
import { Notebook } from "./notes/notebook.ts";
import { CHIEF_OF_STAFF, CHIEF_OF_STAFF_CONVERSATION_ID } from "./staff/chief-of-staff.ts";
import { instructionsFor } from "./staff/identity.ts";
import { proposeSupervisor } from "./staff/proposals.ts";
import type { ConversationRecord, Store } from "./store/store.ts";
import { addDays, isWeekday, localDate, TIMEZONE, zonedInstant } from "./time.ts";

export { ConflictError, InvalidRequestError, NotFoundError } from "./errors.ts";

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
  /** The responsibility the run works under. The gateway refuses its tools once that has ended. */
  responsibilityId?: string | null;
  /** The input holds source data or reports written from it, so the run's notes count as source data. */
  sourceData?: boolean;
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
  /** The notes vault. Without one, the office keeps notes in a temporary folder. */
  vaultDir?: string;
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
  readonly notebook: Notebook;
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
    const vaultDir = options.vaultDir ?? mkdtempSync(join(tmpdir(), "aihub-vault-"));
    this.notebook = new Notebook(vaultDir, this.store, (note) => this.bus.publish({ type: "note", note }));
    this.gateway = new Gateway(this.store, options.tools ?? OFFICE_TOOLS, (entry) => this.bus.publish({ type: "activity", entry }), {
      notebook: this.notebook,
      proposeSupervisor: (caller, proposal) => proposeSupervisor(this, caller, proposal),
    });
  }

  /** Seeds the Chief of Staff and closes out runs that a restart interrupted. */
  start() {
    this.store.upsertAgent(CHIEF_OF_STAFF);
    this.store.ensureConversation({ id: CHIEF_OF_STAFF_CONVERSATION_ID, agentId: CHIEF_OF_STAFF.id, title: CHIEF_OF_STAFF.name });
    for (const run of this.store.failUnfinishedRuns("The daemon stopped before this run finished.")) {
      this.activity(run.agentId, run.id, "run_failed", `${run.title}: stopped by a daemon restart`);
    }
    this.syncProfiles();
  }

  /** Writes every staff member's profile note from its record. */
  syncProfiles() {
    for (const agent of this.store.listAgents()) this.notebook.syncProfile(agent.id);
  }

  /** The operator edits a staff member's name, title, job description, or working style. */
  updateProfile(agentId: string, profile: Partial<StaffProfile>): Agent {
    if (!this.store.getAgentRecord(agentId)) throw new NotFoundError(`No agent ${agentId}`);
    if (profile.name !== undefined && this.store.isNameTaken(profile.name, agentId)) {
      throw new ConflictError(`Someone on staff is already called ${profile.name}.`);
    }
    const agent = this.store.updateProfile(agentId, profile)!;
    this.notebook.syncProfile(agentId);
    this.bus.publish({ type: "agent", agent });
    return agent;
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
      responsibilities: this.store.listResponsibilities(),
      connections: this.store.listConnections(),
      routines: this.store.listRoutines(),
      proposals: this.store.listProposals(),
      items: this.store.listItems(),
      notes: this.notebook.list(),
      office: this.officeStats(),
      runtime: this.runtimeStatus,
      lastEventId: this.bus.lastEventId,
    };
  }

  /** The office's shared counters, from records. */
  officeStats(now = new Date()): OfficeStats {
    const today = localDate(now, TIMEZONE);
    const delivered = new Set(this.store.briefingDeliveries().map((at) => localDate(new Date(at), TIMEZONE)));
    // A streak counts weekdays in a row with a briefing. Today counts once delivered, and doesn't break it before.
    let day = delivered.has(today) ? today : addDays(today, -1);
    let briefingStreak = 0;
    for (; ; day = addDays(day, -1)) {
      if (!isWeekday(day)) continue;
      if (!delivered.has(day)) break;
      briefingStreak++;
    }
    return {
      turnsToday: this.store.usageSince(zonedInstant(today, "00:00", TIMEZONE)).turns,
      dailyTurnLimit: DAILY_TURN_LIMIT,
      activeSupervisors: this.store.countActive("supervisor"),
      supervisorLimit: SUPERVISOR_LIMIT,
      briefingStreak,
    };
  }

  /** The operator dismisses or resolves an item. Its supervisor's journal remembers it. */
  closeItem(id: number, state: "dismissed" | "resolved", resolution: string | null): Item {
    const existing = this.store.getItem(id);
    if (!existing) throw new NotFoundError(`No item ${id}`);
    const item = this.store.closeItem(id, state, resolution);
    if (!item) throw new ConflictError(`This item is already ${existing.state}.`);
    this.bus.publish({ type: "item", item });
    const owner = this.store.getResponsibility(item.responsibilityId)?.ownerId;
    if (owner) {
      this.notebook.journal(owner, `The operator ${state} "${item.title}"${resolution ? `: ${resolution}` : "."}`);
      const agent = this.store.getAgent(owner);
      if (agent) this.bus.publish({ type: "agent", agent });
    }
    return item;
  }

  /** Ends a responsibility, such as a mandate. The gateway refuses every later call under it. */
  endResponsibility(id: string): Responsibility {
    const existing = this.store.getResponsibility(id);
    if (!existing) throw new NotFoundError(`No responsibility ${id}`);
    const responsibility = this.store.endResponsibility(id);
    if (!responsibility) throw new ConflictError("This responsibility has already ended.");
    this.bus.publish({ type: "responsibility", responsibility });
    const agent = this.store.getAgent(responsibility.ownerId);
    if (agent) this.bus.publish({ type: "agent", agent });
    this.activity(responsibility.ownerId, null, "responsibility_ended", `${responsibility.title} ended`);
    this.notebook.syncProfile(responsibility.ownerId);
    return responsibility;
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
    const options: ContextOptions = {
      profile: agent.profile,
      instructions: instructionsFor(agent, this.store.activeResponsibilityOf(agent.id)),
      tools: this.gateway.specsFor(caller),
    };
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
      const journal = `Talked with the operator about "${clip(message.body.replace(/\s+/g, " "), 80)}".`;
      if (result.status === "completed") this.finish(runId, "done", undefined, journal);
      else this.finish(runId, "failed", result.error ?? `The turn was ${result.status}`, journal);
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
    const run = task.runId ? this.store.getRun(task.runId)! : this.openRun(agent.id, task.kind, task.title, task.responsibilityId);
    return new Promise((resolve, reject) =>
      this.queue.enqueue("background", () => this.executeTask(run.id, task).then(resolve, reject)),
    );
  }

  /** Records a new queued run. */
  openRun(agentId: string, kind: RunKind, title: string, responsibilityId: string | null = null): Run {
    const run = this.store.createRun({ agentId, kind, title, responsibilityId });
    this.publishRun(run);
    return run;
  }

  setRunState(runId: string, state: RunState, error?: string) {
    this.publishRun(this.store.setRunState(runId, state, error));
  }

  /** Posts an agent's message, such as a briefing, to a conversation. */
  postMessage(
    conversationId: string,
    agentId: string,
    body: string,
    runId: string | null,
    kind: MessageKind = "chat",
    refId: string | null = null,
  ): ChatMessage {
    const message = this.store.addMessage({ conversationId, author: "agent", agentId, body, runId, kind, refId });
    this.bus.publish({ type: "message", message });
    return message;
  }

  private async executeTask(runId: string, task: Task): Promise<TaskOutcome> {
    const agent = this.store.getAgentRecord(task.agentId)!;
    const caller = { agentId: agent.id, runId, profile: agent.profile, sourceData: task.sourceData ?? agent.profile === "data" };
    this.setRunState(runId, "working");
    this.activity(agent.id, runId, "run_started", `${agent.name}: ${task.title}`);
    let text = "";
    try {
      const contextId = await this.runtime.startContext({
        profile: agent.profile,
        instructions: `${instructionsFor(agent, this.store.activeResponsibilityOf(agent.id))}

${task.instructions}`,
        tools: this.gateway.specsFor(caller),
        ephemeral: true,
      });
      const memory = this.notebook.memoryFor(agent.id);
      const result = await this.runtime.runTurn(contextId, {
        input: memory ? `${memory}\n\n${task.input}` : task.input,
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

    // A new context starts with the agent's memory: its notes index and key notes.
    const memory = this.notebook.memoryFor(conversation.agentId);
    const withMemory = (input: string) => (memory ? `${memory}\n\n${input}` : input);
    const history = this.store
      .recentMessages(this.historyLimit + 1, conversation.id)
      .filter((earlier) => earlier.id !== message.id)
      .slice(-this.historyLimit);
    if (history.length === 0) return { contextId, input: withMemory(message.body) };

    this.activity(conversation.agentId, message.runId, "context_rebuilt", `Restored the chat from ${history.length} saved messages`);
    const agentName = this.store.getAgentRecord(conversation.agentId)?.name ?? "Agent";
    const transcript = history
      .map((earlier) => `${earlier.author === "operator" ? "Operator" : agentName}: ${clip(earlier.body, 2000)}`)
      .join("\n\n");
    return {
      contextId,
      input: withMemory(
        [
          "AiHub restored this conversation from its records. The earlier messages, oldest first:",
          "",
          transcript,
          "",
          "The operator's new message:",
          message.body,
        ].join("\n"),
      ),
    };
  }

  private finish(runId: string, state: "done" | "failed", error?: string, journal?: string) {
    this.setRunState(runId, state, error);
    const run = this.store.getRun(runId)!;
    this.notebook.journal(run.agentId, `${journal ?? `${run.title}.`}${state === "failed" ? " It failed." : ""}`, runId);
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
