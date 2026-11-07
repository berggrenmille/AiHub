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

/** Who a staff member is. The operator can edit it, and its charter starts from it (DESIGN.md › Purpose and scope). */
export interface StaffProfile {
  name: string;
  title: string;
  /** The job description: what this staff member does, in a sentence or two. */
  description: string;
  /** How it works and communicates, such as "Brief, and early with warnings." */
  workingStyle: string;
}

export interface Agent extends StaffProfile {
  id: string;
  role: AgentRole;
  managerId: string | null;
  profile: RunProfile;
  /** Seed for the generated look. */
  avatar: string;
  hiredAt: string;
  /** Delivered results and resolved items. The office counts real work only. */
  experience: number;
  /** The state of the agent's current run, or idle when none is in progress. */
  state: RunState | "idle";
  /** The connections it may read, through unrevoked grants. */
  connectionIds: string[];
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
  /** The responsibility the run works under. Its expiry applies to every tool call. */
  responsibilityId: string | null;
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

/** chat: a conversation turn. briefing: a delivered briefing. proposal: a card for `refId`. notice: AiHub's own note. */
export type MessageKind = "chat" | "briefing" | "proposal" | "notice";

export interface ChatMessage {
  id: number;
  conversationId: string;
  author: "operator" | "agent";
  agentId: string | null;
  kind: MessageKind;
  body: string;
  runId: string | null;
  /** The record a proposal message is about, such as the proposal's ID. */
  refId: string | null;
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
  | "context_rebuilt"
  | "proposal"
  | "approved"
  | "declined"
  | "collected"
  | "item"
  | "responsibility_ended"
  | "briefing"
  | "health";

export interface ActivityEntry {
  id: number;
  at: string;
  agentId: string | null;
  runId: string | null;
  kind: ActivityKind;
  summary: string;
}

/** An ongoing or time-bounded outcome. One with an expiry is a mandate (DESIGN.md › Autonomy and knowledge). */
export interface Responsibility {
  id: string;
  ownerId: string;
  title: string;
  scope: string;
  standingInstructions: string;
  /** When it ends on its own. Null means ongoing. */
  expiresAt: string | null;
  status: "active" | "ended";
  endedAt: string | null;
}

export type SourceKind = "ics_file";

/** An identified local resource or account that collectors read (DESIGN.md › Connectors and capabilities). */
export interface SourceConnection {
  id: string;
  kind: SourceKind;
  label: string;
  /** For a local file, its path. */
  path: string;
  status: "unverified" | "connected" | "failed";
  /** What verification found, such as the number of events or the error. */
  detail: string | null;
  verifiedAt: string | null;
}

export type RoutineTrigger =
  /** Runs on Monday to Friday at a local time, such as "07:00". */
  | { type: "weekdays"; time: string }
  /** Runs as a section of the briefing. */
  | { type: "briefing" };

export interface Routine {
  id: string;
  ownerId: string;
  responsibilityId: string | null;
  title: string;
  trigger: RoutineTrigger;
  timezone: string;
  dailyTurnBudget: number;
  paused: boolean;
  /** The next scheduled time, for scheduled routines. */
  nextRunAt: string | null;
}

/** What a recruitment proposal asks the operator to approve. */
export interface RecruitProposal {
  profile: StaffProfile;
  responsibility: { title: string; scope: string; standingInstructions: string; expiresAt: string | null };
  /** The source the supervisor watches. The operator picks the actual file when approving. */
  source: { kind: SourceKind; label: string } | null;
  reason: string;
}

export interface Proposal {
  id: string;
  kind: "recruit_supervisor";
  proposedBy: string;
  payload: RecruitProposal;
  status: "pending" | "approved" | "declined";
  /** What approval created, or why it was declined. */
  outcome: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type ItemState = "new" | "open" | "resolved" | "dismissed";
export type Urgency = "urgent" | "today" | "this_week" | "fyi";

/** A finding with a stable identity from its source (DESIGN.md › Staff and work model). */
export interface Item {
  id: number;
  responsibilityId: string;
  sourceKey: string;
  title: string;
  detail: string;
  urgency: Urgency;
  state: ItemState;
  firstSeenAt: string;
  lastReportedAt: string | null;
  resolution: string | null;
  updatedAt: string;
}

/** Who wrote a note, and from what kind of run (DESIGN.md › Memory and notes). */
export type NoteProvenance = "operator" | "aihub" | "conversation" | "source_data";

export type NoteKind = "profile" | "journal" | "topic" | "office";

export interface NoteSummary {
  /** Path inside the vault with forward slashes, such as "Staff/work-schedule/Anna Lindqvist.md". */
  path: string;
  title: string;
  /** The staff member whose folder holds the note, or null for the Office folder. */
  ownerId: string | null;
  kind: NoteKind;
  provenance: NoteProvenance;
  /** Titles this note links to with [[wikilinks]]. */
  links: string[];
  updatedAt: string;
}

export interface Note extends NoteSummary {
  /** The markdown after the frontmatter. */
  body: string;
}

/** The office's shared counters. Every number comes from records. */
export interface OfficeStats {
  turnsToday: number;
  dailyTurnLimit: number;
  activeSupervisors: number;
  supervisorLimit: number;
  /** Weekdays in a row with a delivered briefing. */
  briefingStreak: number;
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
  responsibilities: Responsibility[];
  connections: SourceConnection[];
  routines: Routine[];
  /** Pending proposals and recent decisions, newest first. */
  proposals: Proposal[];
  /** New and open items, then recently resolved or dismissed ones. */
  items: Item[];
  notes: NoteSummary[];
  office: OfficeStats;
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
  | { type: "responsibility"; responsibility: Responsibility }
  | { type: "connection"; connection: SourceConnection }
  | { type: "routine"; routine: Routine }
  | { type: "proposal"; proposal: Proposal }
  | { type: "item"; item: Item }
  | { type: "note"; note: NoteSummary }
  | { type: "office"; office: OfficeStats }
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

/** `POST /api/proposals/:id/approve`. A proposal with a source needs the file to read. */
export interface ApproveProposalRequest {
  sourcePath?: string;
}

/** `POST /api/items/:id/resolve`. */
export interface ResolveItemRequest {
  note?: string;
}

/** `POST /api/routines/:id/run` answers 202 with the occurrence it recorded. */
export interface RunRoutineResponse {
  occurrenceId: string;
}

/** `PATCH /api/agents/:id`: the operator edits a staff member's profile. */
export type UpdateAgentRequest = Partial<StaffProfile>;

/** `PUT /api/notes/<path>`: the operator writes a note. */
export interface WriteNoteRequest {
  body: string;
}
