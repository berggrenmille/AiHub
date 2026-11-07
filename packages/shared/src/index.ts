// Types shared by the daemon and the web UI.
// Records from DESIGN.md › Staff and work model land here as they are built.

/** Run states that the roster, activity feed, and office render (DESIGN.md › The office experience). */
export type RunState =
  | "queued"
  | "collecting"
  | "working"
  | "reviewing"
  | "waiting_for_access"
  | "waiting_for_approval"
  | "done"
  | "failed";

/** States in which a run is still in progress. */
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  "queued",
  "collecting",
  "working",
  "reviewing",
  "waiting_for_access",
  "waiting_for_approval",
];

export type AgentRole = "chief_of_staff" | "supervisor" | "worker";

/** Decides which tools and data a run can reach (DESIGN.md › Run profiles). */
export type RunProfile = "data" | "conversation" | "workspace";

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  managerId: string | null;
  profile: RunProfile;
  /** The state of the agent's current run, or idle when none is in progress. */
  state: RunState | "idle";
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export type RunKind = "chat" | "briefing" | "report";

export interface Run {
  id: string;
  agentId: string;
  kind: RunKind;
  title: string;
  state: RunState;
  turns: number;
  usage: Usage;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChatMessage {
  id: number;
  conversationId: string;
  author: "operator" | "agent";
  agentId: string | null;
  body: string;
  runId: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
}

export type ActivityKind =
  | "run_queued"
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "tool_call"
  | "tool_refused"
  | "blocked"
  | "context_rebuilt";

export interface ActivityEntry {
  id: number;
  at: string;
  agentId: string | null;
  runId: string | null;
  kind: ActivityKind;
  summary: string;
}

export interface RuntimeStatus {
  signedIn: boolean;
  detail: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  startedAt: string;
}

/** `GET /api/state`: everything the UI needs before it follows `/api/events`. */
export interface StateSnapshot {
  agents: Agent[];
  conversations: Conversation[];
  /** Recent messages of every conversation, oldest first. */
  messages: ChatMessage[];
  /** Recent runs, newest first. */
  runs: Run[];
  /** Recent activity, newest first. */
  activity: ActivityEntry[];
  runtime: RuntimeStatus | null;
  /** The last event this snapshot includes. Follow the stream with `/api/events?after=<lastEventId>`. */
  lastEventId: string;
}

/** Messages on `/api/events`. Each SSE message's `id` is the daemon's boot ID and a sequence number. */
export type DaemonEvent =
  | { type: "agent"; agent: Agent }
  | { type: "run"; run: Run }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; runId: string; conversationId: string; text: string }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "runtime"; runtime: RuntimeStatus }
  /** The stream can't catch up from the client's last event. Reload `/api/state`, then reconnect. */
  | { type: "resync" };

/** `POST /api/chat`. */
export interface ChatRequest {
  conversationId: string;
  text: string;
}

export interface ChatResponse {
  message: ChatMessage;
  run: Run;
}
