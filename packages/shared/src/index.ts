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
  /** The model it runs on. Null follows the office default. */
  model: string | null;
  /** Its reasoning level. Null follows the model's default. */
  effort: string | null;
}

/** A model staff can run on, from the runtime's catalog (DESIGN.md › Staff and work model). */
export interface ModelOption {
  id: string;
  name: string;
  description: string;
  /** The reasoning levels it offers, lightest first. */
  efforts: Array<{ effort: string; description: string }>;
  defaultEffort: string;
  /** The office default, for staff with no choice of their own. */
  isDefault: boolean;
}

/** A staff member's model and reasoning level. Null follows the default. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

export interface ModelsResponse {
  models: ModelOption[];
}

/** The model and reasoning level the Chief of Staff picked for a supervisor she proposes. */
export interface ProposedModel {
  id: string;
  effort: string;
  /** Why it fits the work. */
  why: string;
}

/** Web search a staff member holds (DESIGN.md › Authority and data boundaries). */
export interface WebGrant {
  /** Sites search is limited to, such as "bbc.com". Empty allows any. */
  sites: string[];
  /**
   * Live search, which opens pages on the sites themselves. It is an unsafe grant the operator gives
   * directly. Cached search, from an index, when false or left out.
   */
  live?: boolean;
}

/** How a service reaches an outside account (DESIGN.md › Connectors and capabilities). */
export type ServiceKind = "app" | "remote_mcp" | "local_mcp";

/** What a service's operation does, as the service labels it. Unlabeled counts as changing things. */
export type OperationLabel = "reads" | "changes" | "unlabeled";

export interface ServiceOperation {
  name: string;
  title: string | null;
  description: string;
  label: OperationLabel;
  /** The service says it may reach parties other than itself, or says nothing either way. */
  openWorld: boolean;
}

/**
 * proposed: waiting for the operator. signed_out: approved, waiting for a sign-in. connected: AiHub
 * can call it. failed: it couldn't be reached. declined and removed: no longer in use.
 */
export type ServiceStatus = "proposed" | "signed_out" | "connected" | "failed" | "declined" | "removed";

/** Something that reaches an outside account: a ChatGPT app with one of its accounts, or an MCP server. */
export interface Service {
  id: string;
  kind: ServiceKind;
  name: string;
  /** For an app, the app. For an MCP server, its address or the program it runs. */
  where: string;
  /** For an app, which of its linked accounts, such as "Work". */
  account: string | null;
  status: ServiceStatus;
  /** What the last check found, or what to do. */
  detail: string | null;
  operations: ServiceOperation[];
  /** Why the Chief of Staff proposed it. */
  reason: string | null;
  proposedBy: string | null;
  /** Why adding it breaks the data boundary, such as a program that runs outside the sandbox. The operator ticks it. */
  unsafe: UnsafeGrant | null;
  /** For an app not connected yet: where the operator connects it at ChatGPT. */
  connectUrl: string | null;
  checkedAt: string | null;
  createdAt: string;
}

/** An operation a staff member may call on a service. */
export interface ServiceGrant {
  id: number;
  agentId: string;
  serviceId: string;
  operation: string;
  /** Why it breaks the data boundary, when it does: the operator approved it directly. */
  unsafe: string | null;
  grantedAt: string;
  lastUsedAt: string | null;
}

/** A grant that breaks the data boundary, which the operator approves on its own (DESIGN.md › Authority and data boundaries). */
export interface UnsafeGrant {
  /** What the operator ticks, such as "operation:<service id>/send_message". */
  key: string;
  /** What it grants, such as "send_message on Work mail". */
  what: string;
  /** What could go wrong, in a sentence. */
  risk: string;
  /** The rest can't work without it, so approving needs the tick. Otherwise an unticked one is left out. */
  required: boolean;
}

/** Turns a service's output into records: where the list is, and which fields say what. Paths are dotted, such as "messages" or "data.items". */
export interface RecordMapping {
  /** Where the list of records is in the output. Empty when the output is the list. */
  list: string;
  /** The field that identifies a record. */
  key: string;
  /** A field that changes when the record does. AiHub fingerprints the record when left out. */
  version?: string;
  title: string;
  time?: string;
  link?: string;
}

/** What a source on a service calls, all fixed when the operator approves it. */
export interface ServiceSource {
  serviceId: string;
  operation: string;
  arguments: Record<string, unknown>;
  mapping: RecordMapping;
}

/** An operation the Chief of Staff proposes a supervisor may call itself. */
export interface ProposedOperation {
  serviceId: string;
  serviceName: string;
  operation: string;
  /** Why the supervisor needs it. */
  why: string;
  /** Why it breaks the data boundary, as AiHub words it, or null when it doesn't. */
  unsafe: string | null;
}

/** A ChatGPT app on AiHub's Codex sign-in, connected or not. */
export interface AppListing {
  id: string;
  name: string;
  description: string | null;
  connected: boolean;
  /** Where the operator connects it at ChatGPT. */
  connectUrl: string | null;
  /** Its linked accounts, once connected. */
  accounts: string[];
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * What a run is for. chat: a conversation turn. briefing and report: the morning briefing and a
 * supervisor's section of it. question: answering a colleague. assignment: working on a task.
 * follow_up: the requester resuming once what it asked for has arrived. review: the Chief of Staff
 * reviewing the staff from AiHub's counts.
 */
export type RunKind = "chat" | "briefing" | "report" | "question" | "assignment" | "follow_up" | "review";

/** Every run kind, for checks and filters. */
export const RUN_KINDS: readonly RunKind[] = ["chat", "briefing", "report", "question", "assignment", "follow_up", "review"];

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
  /** The model its last turn ran on, as the runtime reported it. */
  model: string | null;
  /** That turn's reasoning level, when the runtime named one. */
  effort: string | null;
}

/**
 * chat: a conversation turn. briefing: a delivered briefing. proposal, policy, and staff_change: a
 * card for the record `refId`. notice: AiHub's own note. review: the Chief of Staff's staff review.
 */
export type MessageKind = "chat" | "briefing" | "proposal" | "notice" | "policy" | "review" | "staff_change" | "service";

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
  | "web"
  | "policy"
  | "model"
  | "view"
  | "review"
  | "service"
  /** The operator took access away, such as a source from a staff member. */
  | "access";

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

/** A calendar export, a folder of files that a reader turns into records, or an operation on a service. */
export type SourceKind = "ics_file" | "folder" | "service";

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
  /** For a source on a service: what it calls. */
  service: ServiceSource | null;
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
  /** For a source on a service: what it calls. Nothing is left for the operator to pick. */
  service?: ServiceSource;
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
  /** What the supervisor runs on. Proposals from before the choice existed have none. */
  model?: ProposedModel | null;
  /** Operations on services the supervisor may call itself, beyond what its source reads. */
  operations?: ProposedOperation[];
  /** The grants in this proposal that break the data boundary, each for the operator to tick. */
  unsafe?: UnsafeGrant[];
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

/** What a staff change does once approved (DESIGN.md › Staff review). */
export type StaffChangeDetail =
  /** Replaces the responsibility's scope and standing instructions. `before` is what they were when proposed. */
  | { kind: "instructions"; scope: string; standingInstructions: string; before: { scope: string; standingInstructions: string } }
  /** Sets the model and reasoning level. `before` is the supervisor's choice when proposed. */
  | { kind: "model"; model: ProposedModel; before: ModelChoice }
  /** Ends the responsibility; the supervisor leaves. */
  | { kind: "end" }
  /** A new supervisor takes over the responsibility; the old one leaves. Without a model, it keeps the old one's. */
  | { kind: "replace"; profile: StaffProfile; model: ProposedModel | null };

export type StaffChangeKind = StaffChangeDetail["kind"];

/** A change to a supervisor the Chief of Staff proposes, which applies once the operator approves it. */
export interface StaffChange {
  id: number;
  agentId: string;
  /** Kept on the record, so it reads well after the supervisor has left. */
  agentName: string;
  responsibilityId: string;
  responsibilityTitle: string;
  change: StaffChangeDetail;
  /** Why, in the operator's terms. */
  reason: string;
  proposedBy: string;
  runId: string | null;
  /** Proposed in a chat that held source data, so text from outside AiHub may have shaped it. */
  fromSourceData: boolean;
  status: "pending" | "approved" | "declined" | "withdrawn";
  /** What approval did, or why it was declined or withdrawn. */
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
  /**
   * The operator has to do or decide something, such as fix a clash or check a charge. Only these go
   * in the Inbox. The rest, such as a moved meeting or a news story, are worth knowing: the briefing
   * tells the operator, and they lapse after a couple of days.
   */
  needsOperator: boolean;
  state: ItemState;
  firstSeenAt: string;
  lastReportedAt: string | null;
  resolution: string | null;
  updatedAt: string;
  /** Where the operator opens the record it came from, such as the message in their mail, when the source says. */
  link: string | null;
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
  /** When the Chief of Staff last reviewed the staff, if ever. */
  staffReviewAt: string | null;
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
  /** The office policy's versions and proposals, newest first. */
  policies: PolicyVersion[];
  /** Staff changes waiting for the operator, and recent decisions, newest first. */
  staffChanges: StaffChange[];
  /** Dashboards, and the views under the messages in this snapshot. */
  views: View[];
  /** Services AiHub reaches outside accounts through, including those proposed or removed, newest first. */
  services: Service[];
  /** Operations staff may call on services. */
  serviceGrants: ServiceGrant[];
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
  | { type: "policy"; policy: PolicyVersion }
  | { type: "staff_change"; change: StaffChange }
  | { type: "view"; view: View }
  | { type: "service"; service: Service }
  /** Every operation staff may call on services, after any change. */
  | { type: "service_grants"; grants: ServiceGrant[] }
  /** The operator removed a dashboard. */
  | { type: "view_removed"; viewId: string }
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
  /** The keys of the unsafe grants the operator ticked. Unticked ones are left out, or block approval when required. */
  unsafe?: string[];
}

/** `POST /api/services/:id/approve`: a service with an unsafe grant needs its tick. */
export interface ApproveServiceRequest {
  unsafe?: string[];
}

/** `POST /api/services/:id/sign-in`: the address to open in the operator's browser. AiHub opens it too. */
export interface ServiceSignInResponse {
  url: string;
}

/** `GET /api/services/apps`: the ChatGPT apps connected to AiHub's Codex sign-in. */
export interface AppsResponse {
  apps: AppListing[];
}

/** A staff member's AiHub tools for each kind of run, as the gateway gives them. */
export interface StaffTools {
  agentId: string;
  kinds: Array<{ kind: RunKind; tools: string[] }>;
}

/** `GET /api/access`: what the Access panel needs beyond the snapshot. */
export interface AccessResponse {
  staff: StaffTools[];
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

/** `POST /api/items/:id/resolve` and `/dismiss`: how it was resolved, or why it was dismissed. */
export interface CloseItemRequest {
  note?: string;
}

/** `POST /api/routines/:id/run` answers 202 with the occurrence it recorded. */
export interface RunRoutineResponse {
  occurrenceId: string;
}

/** `PATCH /api/agents/:id`: the operator edits a staff member's profile. */
export type UpdateAgentRequest = Partial<StaffProfile>;

/**
 * A version of the office policy: the operator's rules that every staff member works under
 * (DESIGN.md › Memory and notes). The operator writes one directly; the Chief of Staff proposes one,
 * which applies only once the operator approves it. The current policy is the newest approved one.
 */
export interface PolicyVersion {
  id: number;
  /** The whole policy, in plain text or markdown. */
  body: string;
  /** Who proposed it, or null when the operator wrote it. */
  authorId: string | null;
  /** Why the change, from the proposal. */
  reason: string | null;
  /** The approved version it changes, or null for the first. */
  basedOn: number | null;
  status: "pending" | "approved" | "declined" | "withdrawn";
  /** Drafted in a run that had taken in source data, such as a briefing or a web search. */
  fromSourceData: boolean;
  /** Why it was declined or withdrawn. */
  outcome: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * Where a view shows (DESIGN.md › Views): under a staff member's chat reply, in their section of the
 * briefing, or as a dashboard the operator opens from the Dashboards tab.
 */
export type ViewKind = "reply" | "section" | "dashboard";

/** Interface a staff member wrote in OpenUI Lang, checked by the daemon and drawn by the web app. */
export interface View {
  id: string;
  kind: ViewKind;
  /** Who wrote it. A dashboard by the Chief of Staff is the office's. */
  agentId: string;
  /** The run that handed it in, or last changed a dashboard. */
  runId: string | null;
  /** The chat or briefing message it shows under, once that is posted. */
  messageId: number | null;
  title: string;
  /** The program, in OpenUI Lang. */
  program: string;
  /**
   * Whether images and pages from outside AiHub load by themselves, or wait for the operator's click.
   * They load only in views by staff that hold no personal data.
   */
  outside: "load" | "ask";
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/views/data`: a dashboard fetches with one of the read-only data tools. */
export interface ViewDataRequest {
  tool: string;
  args?: Record<string, unknown>;
}

/** `PUT /api/policy`: the operator writes the policy. */
export interface WritePolicyRequest {
  body: string;
}

/** `PATCH /api/routines/:id`: a scheduled routine runs on weekends too, or on weekdays only. */
export interface UpdateRoutineRequest {
  weekends: boolean;
}

/** `PUT /api/notes/<path>`: the operator writes a note. */
export interface WriteNoteRequest {
  body: string;
}
