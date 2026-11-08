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
  /** Web search, when the operator granted it. */
  web: WebGrant | null;
}

/** Web search a staff member holds (DESIGN.md › Authority and data boundaries). */
export interface WebGrant {
  /** Sites search is limited to, such as "bbc.com". Empty allows any. */
  sites: string[];
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * What a run is for. chat: a conversation turn. briefing and report: the morning briefing and a
 * supervisor's section of it. question: answering a colleague. assignment: working on a task.
 * follow_up: the requester resuming once what it asked for has arrived.
 */
export type RunKind = "chat" | "briefing" | "report" | "question" | "assignment" | "follow_up";

export interface Run {
  id: string;
  agentId: string;
  /** The responsibility the run works under. Its expiry applies to every tool call. */
  responsibilityId: string | null;
  /** The assignment the run works on or follows up, for question, assignment, and follow-up runs. */
  assignmentId: string | null;
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
  | "health"
  | "assignment"
  | "worker"
  | "web";

export interface ActivityEntry {
  id: number;
  at: string;
  agentId: string | null;
  runId: string | null;
  kind: ActivityKind;
  summary: string;
}

/** A question to a colleague, or bounded work handed to one (DESIGN.md › Recruitment and delegation). */
export type AssignmentKind = "question" | "task";

/**
 * open: the owner is on it. waiting: the owner handed parts to others and waits for them.
 * delivered: the result is in. accepted: the requester reviewed a worker's result and took it.
 * failed: a run failed or the run budget ran out.
 */
export type AssignmentStatus = "open" | "waiting" | "delivered" | "accepted" | "failed";

export interface Assignment {
  id: string;
  kind: AssignmentKind;
  requesterId: string;
  /** Kept on the record, so it reads well after a worker has left. */
  requesterName: string;
  ownerId: string;
  ownerName: string;
  /** The assignment this one serves, such as the supervisor's task a worker helps with. */
  parentId: string | null;
  /** The chat the requester continues in when the result arrives, for one asked from a chat. */
  conversationId: string | null;
  title: string;
  /** The question or the deliverable, in the requester's words. */
  brief: string;
  status: AssignmentStatus;
  /** Most runs it may use: the owner's runs plus follow-ups. */
  runBudget: number;
  runsUsed: number;
  /** The answer or the deliverable, once delivered. */
  result: string | null;
  /** The requester's review of a worker's result: what to revise, or a note on acceptance. */
  review: string | null;
  createdAt: string;
  updatedAt: string;
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

/** A calendar export, or a folder of files that a reader turns into records. */
export type SourceKind = "ics_file" | "folder";

/** The readers AiHub has built in, for folder sources. */
export type BuiltInReader = "markdown" | "text" | "csv" | "json";

/** An identified local resource or account that collectors read (DESIGN.md › Connectors and capabilities). */
export interface SourceConnection {
  id: string;
  kind: SourceKind;
  label: string;
  /** For a local file or folder, its path. */
  path: string;
  /** For a folder: the files it reads, such as "*.md". */
  pattern: string | null;
  /** For a folder: the reader that turns each file into records. */
  reader: string | null;
  status: "unverified" | "connected" | "failed";
  /** What verification found, such as the number of events or the error. */
  detail: string | null;
  verifiedAt: string | null;
}

export type RoutineTrigger =
  /** Runs on Monday to Friday at a local time, such as "07:00". */
  | { type: "weekdays"; time: string }
  /** Runs every day, weekends too, at a local time. */
  | { type: "daily"; time: string }
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

/** A source as proposed: what it is, but not yet where. */
export interface ProposedSource {
  kind: SourceKind;
  label: string;
  /** For a folder: the reader for its files, built in or "staff:<id>" for one a toolsmith wrote, and which files to read. */
  reader?: string;
  pattern?: string;
}

export type StaffReaderStatus = "drafting" | "proposed" | "approved" | "failed";

/** A reader a toolsmith wrote for files no built-in reader covers (DESIGN.md › Connectors and capabilities). */
export interface StaffReader {
  id: string;
  name: string;
  /** What the files look like, as the Chief of Staff described them. */
  format: string;
  /** Which files it reads, such as "*.txt". */
  pattern: string;
  /** The sample files it was written and tested against. */
  sampleNames: string[];
  status: StaffReaderStatus;
  /** The code, once the toolsmith submitted it. */
  code: string | null;
  /** The toolsmith's note on how it works and what it can't handle. */
  notes: string | null;
  authorId: string | null;
  /** Kept on the record, so it reads well after the toolsmith has left. */
  authorName: string | null;
  requesterId: string;
  assignmentId: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a recruitment proposal asks the operator to approve. */
export interface RecruitProposal {
  profile: StaffProfile;
  responsibility: { title: string; scope: string; standingInstructions: string; expiresAt: string | null };
  /** The source the supervisor watches. The operator picks the actual file or folder when approving. */
  source: ProposedSource | null;
  /** Web search, for a supervisor that looks things up instead of, or as well as, reading a source. */
  web?: WebGrant | null;
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
  /** Open and waiting assignments, then the most recent settled ones, newest first. */
  assignments: Assignment[];
  /** Readers staff wrote, newest first. */
  readers: StaffReader[];
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
  | { type: "assignment"; assignment: Assignment }
  | { type: "reader"; reader: StaffReader }
  /** A conversation was opened, such as the operator's first chat with a supervisor. */
  | { type: "conversation"; conversation: Conversation }
  /** A staff member left the office, such as a worker whose task is accepted. Its records stay. */
  | { type: "agent_left"; agentId: string }
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

/** `POST /api/agents/:id/chat` opens the operator's chat with that staff member, or finds it. */
export interface OpenChatResponse {
  conversation: Conversation;
}

/** `POST /api/proposals/:id/approve`. A proposal with a source needs the file or folder to read. */
export interface ApproveProposalRequest {
  sourcePath?: string;
}

/**
 * `POST /api/proposals/:id/preview` with `{ sourcePath }`: what the proposed source would read there,
 * such as the first records a toolsmith's reader finds in the real folder. Nothing is created.
 */
export interface SourcePreview {
  /** What was read, or why it couldn't be. */
  summary: string;
  /** The first records, as the read tool returns them: `{ records }` for a folder, `{ series, events }` for a calendar. */
  data: unknown;
  /** The reader's code, for a reader staff wrote, so the operator sees what they approve. */
  code: string | null;
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

/** `PATCH /api/routines/:id`: a scheduled routine runs on weekends too, or on weekdays only. */
export interface UpdateRoutineRequest {
  weekends: boolean;
}

/** `PUT /api/notes/<path>`: the operator writes a note. */
export interface WriteNoteRequest {
  body: string;
}
