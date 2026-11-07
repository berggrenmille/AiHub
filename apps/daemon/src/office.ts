import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActivityKind,
  Agent,
  ChatMessage,
  ChatResponse,
  Conversation,
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
import { ContextUnavailableError, type AgentRuntime, type ContextOptions, type TurnBlocker, type TurnResult } from "./runtime/types.ts";
import { DAILY_TURN_LIMIT, SUPERVISOR_LIMIT } from "./limits.ts";
import { Notebook } from "./notes/notebook.ts";
import { CHIEF_OF_STAFF, CHIEF_OF_STAFF_CONVERSATION_ID } from "./staff/chief-of-staff.ts";
import { DIRECT_CHAT_INSTRUCTIONS } from "./staff/supervisor.ts";
import { instructionsFor } from "./staff/identity.ts";
import { Delegation } from "./staff/delegation.ts";
import { Toolsmith } from "./staff/toolsmith.ts";
import { proposeSupervisor } from "./staff/proposals.ts";
import type { SourceContext } from "./sources/source.ts";
import type { Scheduler } from "./scheduler.ts";
import { NO_PLATFORM, type Platform } from "./platform.ts";
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
  /** The question or task the run works on. */
  assignmentId?: string | null;
}

/** What a chat turn answers: the operator's message, or news AiHub brings to the conversation. */
interface ChatPrompt {
  text: string;
  /** Introduces `text` when a rebuilt context replays the earlier messages first. */
  label: string;
  /** The message `text` came from, left out of the replayed history. */
  messageId: number | null;
  journal: string;
  sourceData: boolean;
}

/** What a chat turn sends into its thread. */
interface ThreadInput {
  contextId: string;
  input: string;
  /** The thread holds source data, so the turn counts as source data. */
  sourceData: boolean;
  /** The newest message the thread will have taken in once the turn runs. */
  seenMessageId: number;
}

/** At most this many posted messages are brought into a turn at once. */
const POSTED_LIMIT = 5;

export interface TaskOutcome {
  run: Run;
  /** The agent's final message. */
  text: string;
  /** Why the turn couldn't run, when waiting may fix it. */
  blocker: TurnBlocker | null;
}

/** Why Codex can't run a turn now, when waiting may fix it. */
export interface Blocked {
  blocker: TurnBlocker;
  /** What stands in the way, for the operator. */
  detail: string;
  /** When the plan's usage resets, if that is what stands in the way. */
  resetsAt: Date | null;
}

const BLOCKED_DETAIL: Record<TurnBlocker, string> = {
  usage: "The Codex plan's usage is used up",
  signed_out: "Codex isn't signed in",
  offline: "Codex can't reach the internet",
  busy: "Codex is busy",
};

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
  /** Notifications, staying awake, and waking the PC. Nothing, when left out. */
  platform?: Platform;
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
  /** Set by the daemon once it schedules routines. */
  scheduler: Scheduler | null = null;
  readonly platform: Platform;
  readonly delegation: Delegation;
  readonly toolsmith: Toolsmith;

  constructor(options: OfficeOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.queue = options.queue ?? new RunQueue();
    this.historyLimit = options.historyLimit ?? 20;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.platform = options.platform ?? NO_PLATFORM;
    const vaultDir = options.vaultDir ?? mkdtempSync(join(tmpdir(), "aihub-vault-"));
    this.notebook = new Notebook(vaultDir, this.store, (note) => this.bus.publish({ type: "note", note }));
    this.delegation = new Delegation(this);
    this.toolsmith = new Toolsmith(this);
    this.gateway = new Gateway(this.store, options.tools ?? OFFICE_TOOLS, (entry) => this.bus.publish({ type: "activity", entry }), {
      notebook: this.notebook,
      proposeSupervisor: (caller, proposal) => proposeSupervisor(this, caller, proposal),
      delegation: this.delegation,
      toolsmith: this.toolsmith,
      sourceContext: () => this.sourceContext(),
    });
  }

  /** What source adapters get from the office: the readers staff wrote and the operator approved. */
  sourceContext(now = new Date()): SourceContext {
    return { now, staffReader: (id) => this.toolsmith.approved(id) };
  }

  /** For checking a proposed source before approval: a reader handed in but not yet approved runs too, in the sandbox. */
  candidateSourceContext(now = new Date()): SourceContext {
    return { now, staffReader: (id) => this.toolsmith.candidate(id) };
  }

  /** Seeds the Chief of Staff and closes out runs that a restart interrupted. */
  start() {
    this.store.upsertAgent(CHIEF_OF_STAFF);
    this.store.ensureConversation({ id: CHIEF_OF_STAFF_CONVERSATION_ID, agentId: CHIEF_OF_STAFF.id, title: CHIEF_OF_STAFF.name });
    for (const run of this.store.failUnfinishedRuns("The daemon stopped before this run finished.")) {
      this.activity(run.agentId, run.id, "run_failed", `${run.title}: stopped by a daemon restart`);
    }
    this.syncProfiles();
    // Every office has the weekday briefing. It runs once a supervisor reports to it.
    const hasBriefing = this.store.listRoutines().some((routine) => routine.ownerId === CHIEF_OF_STAFF.id && routine.trigger.type === "weekdays");
    if (!hasBriefing) {
      this.store.createRoutine({
        ownerId: CHIEF_OF_STAFF.id,
        responsibilityId: null,
        title: "Morning briefing",
        trigger: { type: "weekdays", time: "07:00" },
        timezone: TIMEZONE,
        dailyTurnBudget: 6,
      });
    }
    this.delegation.resume();
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

  /** The plan's usage window, as the runtime reports it. */
  usageLimits() {
    return this.runtime.usageLimits();
  }

  /**
   * Checks, without a model turn, whether Codex could run one now: it answers, someone is signed
   * in, and the plan has usage left. Codex can't even say who is signed in without reaching the
   * service, so a check that fails counts as offline.
   */
  async readiness(): Promise<Blocked | null> {
    const { signedIn, unavailable } = await this.checkRuntime();
    if (unavailable) return { blocker: "offline", detail: unavailable, resetsAt: null };
    if (!signedIn) return { blocker: "signed_out", detail: BLOCKED_DETAIL.signed_out, resetsAt: null };
    const usage = await this.runtime.usageLimits().catch(() => null);
    if (usage?.exhausted) return { blocker: "usage", detail: BLOCKED_DETAIL.usage, resetsAt: usage.resetsAt };
    return null;
  }

  /** Describes a blocker a turn ran into, with when usage resets if that is the one. */
  async blocked(blocker: TurnBlocker): Promise<Blocked> {
    const usage = blocker === "usage" ? await this.runtime.usageLimits().catch(() => null) : null;
    return { blocker, detail: BLOCKED_DETAIL[blocker], resetsAt: usage?.resetsAt ?? null };
  }

  /** Asks the runtime who is signed in and publishes the answer. */
  async refreshRuntimeStatus(): Promise<RuntimeStatus> {
    return (await this.checkRuntime()).status;
  }

  /** Asks the runtime who is signed in, publishes the answer, and says why if Codex didn't answer. */
  async checkRuntime(): Promise<{ status: RuntimeStatus; signedIn: boolean; unavailable: string | null }> {
    let status: RuntimeStatus;
    let unavailable: string | null = null;
    try {
      status = await this.runtime.account();
    } catch (error) {
      unavailable = `Codex is unavailable: ${errorText(error)}`;
      status = { signedIn: false, detail: unavailable };
    }
    this.publishRuntimeStatus(status);
    return { status, signedIn: status.signedIn, unavailable };
  }

  private publishRuntimeStatus(status: RuntimeStatus) {
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
      routines: this.store.listRoutines().map((routine) => ({ ...routine, nextRunAt: this.scheduler?.nextRunAt(routine) ?? null })),
      proposals: this.store.listProposals(),
      items: this.store.listItems(),
      assignments: this.store.listAssignments(),
      readers: this.store.listReaders(),
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

  /** Opens the operator's chat with a staff member, or finds the one already open. */
  openChat(agentId: string): Conversation {
    const agent = this.store.getAgentRecord(agentId);
    if (!agent) throw new NotFoundError(`No agent ${agentId}`);
    const existing = this.store.listConversations().find((conversation) => conversation.agentId === agentId);
    if (existing) return existing;
    if (agent.status !== "active") throw new ConflictError(`${agent.name} has left the office.`);
    const conversation = { id: `chat-${agentId}`, agentId, title: agent.name };
    this.store.ensureConversation(conversation);
    this.bus.publish({ type: "conversation", conversation });
    return conversation;
  }

  /** Records the operator's message and queues the reply. Returns before the reply starts. */
  chat(conversationId: string, text: string): ChatResponse {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new NotFoundError(`No conversation ${conversationId}`);
    const member = this.store.getAgentRecord(conversation.agentId);
    if (member?.status !== "active") throw new ConflictError(`${member?.name ?? "This staff member"} has left the office, so the chat is closed.`);
    const run = this.store.createRun({ agentId: conversation.agentId, kind: "chat", title: "Reply in chat" });
    const message = this.store.addMessage({ conversationId, author: "operator", agentId: null, body: text, runId: run.id });
    this.bus.publish({ type: "message", message });
    this.publishRun(run);
    const prompt: ChatPrompt = {
      text,
      label: "The operator's new message:",
      messageId: message.id,
      journal: `Talked with the operator about "${clip(text.replace(/\s+/g, " "), 80)}".`,
      sourceData: false,
    };
    this.queue.enqueue("interactive", () => this.reply(run.id, conversation.id, prompt).then(() => {}));
    return { message, run };
  }

  /**
   * Brings news into a chat, such as a colleague's answer, as a new turn of the same thread. The agent
   * tells the operator; nothing is posted as if the operator had said it. Resolves when the turn ends.
   */
  continueChat(conversationId: string, prompt: { title: string; input: string; journal: string; assignmentId?: string | null }): Promise<TaskOutcome> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new NotFoundError(`No conversation ${conversationId}`);
    const run = this.store.createRun({ agentId: conversation.agentId, kind: "follow_up", title: prompt.title, assignmentId: prompt.assignmentId ?? null });
    this.publishRun(run);
    const turn: ChatPrompt = { text: prompt.input, label: "New from AiHub:", messageId: null, journal: prompt.journal, sourceData: true };
    return new Promise((resolve, reject) => this.queue.enqueue("interactive", () => this.reply(run.id, conversationId, turn).then(resolve, reject)));
  }

  private async reply(runId: string, conversationId: string, prompt: ChatPrompt): Promise<TaskOutcome> {
    const conversation = this.store.getConversation(conversationId)!;
    const agent = this.store.getAgentRecord(conversation.agentId)!;
    const run = this.store.getRun(runId)!;
    // A data run's chat reads its sources, so everything it writes counts as source data.
    const caller = { agentId: agent.id, runId, profile: agent.profile, sourceData: prompt.sourceData || agent.profile === "data" };
    const charter = instructionsFor(agent, this.store.activeResponsibilityOf(agent.id), this.sourceNamesOf(agent.id));
    // Every turn of a thread is offered the same tools, so a follow-up doesn't restart the thread.
    const options: ContextOptions = {
      profile: agent.profile,
      instructions: agent.role === "chief_of_staff" ? charter : `${charter}\n\n${DIRECT_CHAT_INSTRUCTIONS}`,
      tools: this.gateway.specsFor(caller, "chat"),
    };
    this.setRunState(runId, "working");
    this.activity(agent.id, runId, "run_started", run.kind === "chat" ? `${agent.name} is replying in chat` : `${agent.name}: ${run.title}`);

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

    let text = "";
    let blocker: TurnBlocker | null = null;
    // Once source data enters a thread, every later turn in it counts as source data.
    const taken = (context: ThreadInput) => {
      if (context.sourceData) caller.sourceData = true;
      if (caller.sourceData) this.store.setConversationThread(conversationId, { sourceData: true });
      return context;
    };
    try {
      let context = taken(await this.openContext(conversation, options, prompt, runId));
      let result: TurnResult;
      try {
        result = await turn(context.contextId, context.input);
      } catch (error) {
        // The runtime lost the thread mid-session, for example after a crash it could not resume.
        if (!(error instanceof ContextUnavailableError)) throw error;
        this.liveContexts.delete(context.contextId);
        context = taken(await this.rebuildContext(conversation, options, prompt, runId));
        result = await turn(context.contextId, context.input);
      }
      this.publishRun(this.store.addTurn(runId, result.usage));
      text = result.text;
      blocker = result.blocker ?? null;
      // The thread now holds what the turn took in, even if the turn failed partway.
      if (result.status === "completed") this.store.setConversationThread(conversationId, { seenMessageId: context.seenMessageId });
      if (result.text) this.postMessage(conversationId, agent.id, result.text, runId, "chat", null, caller.sourceData);
      if (result.status === "completed") this.finishRun(runId, "done", undefined, prompt.journal);
      else this.finishRun(runId, "failed", result.error ?? `The turn was ${result.status}`, prompt.journal);
    } catch (error) {
      this.finishRun(runId, "failed", errorText(error));
    }
    return { run: this.store.getRun(runId)!, text, blocker };
  }

  /**
   * Queues one background turn in a fresh, ephemeral context: background runs start from records
   * every time (DESIGN.md › Context assembly). Resolves when the run has ended, done or failed.
   */
  runTask(task: Task): Promise<TaskOutcome> {
    const agent = this.store.getAgentRecord(task.agentId);
    if (!agent) throw new NotFoundError(`No agent ${task.agentId}`);
    const run = task.runId
      ? this.store.getRun(task.runId)!
      : this.openRun(agent.id, task.kind, task.title, task.responsibilityId, task.assignmentId);
    return new Promise((resolve, reject) =>
      this.queue.enqueue("background", () => this.executeTask(run.id, task).then(resolve, reject)),
    );
  }

  /** Records a new queued run. */
  openRun(agentId: string, kind: RunKind, title: string, responsibilityId: string | null = null, assignmentId: string | null = null): Run {
    const run = this.store.createRun({ agentId, kind, title, responsibilityId, assignmentId });
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
    sourceData = false,
  ): ChatMessage {
    const message = this.store.addMessage({ conversationId, author: "agent", agentId, body, runId, kind, refId, sourceData });
    this.bus.publish({ type: "message", message });
    return message;
  }

  private sourceNamesOf(agentId: string): string[] {
    return this.store.connectionsOf(agentId).map((connection) => connection.label);
  }

  private async executeTask(runId: string, task: Task): Promise<TaskOutcome> {
    const agent = this.store.getAgentRecord(task.agentId)!;
    const caller = { agentId: agent.id, runId, profile: agent.profile, sourceData: task.sourceData ?? agent.profile === "data" };
    this.setRunState(runId, "working");
    this.activity(agent.id, runId, "run_started", `${agent.name}: ${task.title}`);
    let text = "";
    let blocker: TurnBlocker | null = null;
    try {
      // A worker has no responsibility of its own: it works under its supervisor's, the run's.
      const responsibility =
        this.store.activeResponsibilityOf(agent.id) ?? (task.responsibilityId ? this.store.getResponsibility(task.responsibilityId) : null);
      const contextId = await this.runtime.startContext({
        profile: agent.profile,
        instructions: `${instructionsFor(agent, responsibility, this.sourceNamesOf(agent.id))}

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
      blocker = result.blocker ?? null;
      if (result.status === "completed") this.finishRun(runId, "done");
      else this.finishRun(runId, "failed", result.error ?? `The turn was ${result.status}`);
    } catch (error) {
      this.finishRun(runId, "failed", errorText(error));
    }
    return { run: this.store.getRun(runId)!, text, blocker };
  }

  /**
   * Model threads are a cache (DESIGN.md › Context assembly). Resume the saved thread if it was
   * started with the same charter and tools; otherwise start a new one from the saved messages.
   */
  private async openContext(conversation: ConversationRecord, options: ContextOptions, prompt: ChatPrompt, runId: string): Promise<ThreadInput> {
    const saved = conversation.contextFingerprint === fingerprintOf(options) ? conversation.contextId : null;
    if (saved && !this.liveContexts.has(saved)) {
      try {
        await this.runtime.resumeContext(saved, options);
        this.liveContexts.add(saved);
      } catch (error) {
        if (!(error instanceof ContextUnavailableError)) throw error;
        return this.rebuildContext(conversation, options, prompt, runId);
      }
    }
    if (!saved) return this.rebuildContext(conversation, options, prompt, runId);
    return { contextId: saved, ...this.withPosted(conversation, prompt) };
  }

  /**
   * A live thread hasn't seen what was posted to its chat since its last turn, such as the morning
   * briefing or a notice. The turn brings that in first; a briefing comes inside data markers.
   */
  private withPosted(conversation: ConversationRecord, prompt: ChatPrompt): Omit<ThreadInput, "contextId"> {
    const seenMessageId = this.store.lastMessageId(conversation.id);
    const posted = this.store
      .messagesAfter(conversation.id, conversation.seenMessageId)
      .filter((message) => message.author === "agent" && (message.kind === "briefing" || message.kind === "notice"))
      .slice(-POSTED_LIMIT);
    const sourceData = conversation.sourceData || posted.some((message) => message.sourceData);
    if (!posted.length) return { input: prompt.text, sourceData, seenMessageId };
    const blocks = posted.map((message) => {
      const what = message.kind === "briefing" ? "The briefing you posted" : "A notice AiHub posted";
      const body = clip(message.body, 4000);
      return message.sourceData ? `${what}, written from source data:\nBEGIN SOURCE DATA\n${body}\nEND SOURCE DATA` : `${what}:\n${body}`;
    });
    return {
      input: ["Posted in this chat since your last reply, for context:", "", blocks.join("\n\n"), "", prompt.label, prompt.text].join("\n"),
      sourceData,
      seenMessageId,
    };
  }

  /** Starts a new thread from the chat's saved messages. It holds source data only if they do. */
  private async rebuildContext(conversation: ConversationRecord, options: ContextOptions, prompt: ChatPrompt, runId: string): Promise<ThreadInput> {
    const contextId = await this.runtime.startContext(options);
    this.store.setConversationContext(conversation.id, contextId, fingerprintOf(options));
    this.liveContexts.add(contextId);
    const seenMessageId = this.store.lastMessageId(conversation.id);

    // A new context starts with the agent's memory: its notes index and key notes.
    const memory = this.notebook.memoryFor(conversation.agentId);
    const withMemory = (input: string) => (memory ? `${memory}\n\n${input}` : input);
    const history = this.store
      .recentMessages(this.historyLimit + 1, conversation.id)
      .filter((earlier) => earlier.id !== prompt.messageId)
      .slice(-this.historyLimit);
    const fromSourceData = this.store.sourceDataAmong(history.map((earlier) => earlier.id));
    this.store.setConversationThread(conversation.id, { sourceData: fromSourceData.size > 0 });
    if (history.length === 0) return { contextId, input: withMemory(prompt.text), sourceData: false, seenMessageId };

    this.activity(conversation.agentId, runId, "context_rebuilt", `Restored the chat from ${history.length} saved messages`);
    const agentName = this.store.getAgentRecord(conversation.agentId)?.name ?? "Agent";
    const transcript = history
      .map((earlier) => {
        const who = earlier.author === "operator" ? "Operator" : agentName;
        const body = clip(earlier.body, 2000);
        return fromSourceData.has(earlier.id) ? `${who}, written from source data:\nBEGIN SOURCE DATA\n${body}\nEND SOURCE DATA` : `${who}: ${body}`;
      })
      .join("\n\n");
    return {
      contextId,
      input: withMemory(
        [
          "AiHub restored this conversation from its records. The earlier messages, oldest first:",
          "",
          transcript,
          "",
          prompt.label,
          prompt.text,
        ].join("\n"),
      ),
      sourceData: fromSourceData.size > 0,
      seenMessageId,
    };
  }

  /** Closes a run: its state, a journal line, and an activity entry. */
  finishRun(runId: string, state: "done" | "failed", error?: string, journal?: string) {
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
