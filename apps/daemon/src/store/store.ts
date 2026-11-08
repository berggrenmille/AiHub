import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ACTIVE_RUN_STATES,
  type ActivityEntry,
  type Assignment,
  type AssignmentKind,
  type AssignmentStatus,
  type ActivityKind,
  type Agent,
  type AgentRole,
  type ChatMessage,
  type Conversation,
  type Item,
  type ItemState,
  type MessageKind,
  type Proposal,
  type RecruitProposal,
  type Responsibility,
  type Routine,
  type PolicyVersion,
  type RoutineTrigger,
  type Run,
  type RunKind,
  type RunProfile,
  type RunState,
  type SourceConnection,
  type WebGrant,
  type SourceKind,
  type StaffProfile,
  type StaffReader,
  type View,
  type StaffReaderStatus,
  type Urgency,
  type Usage,
} from "@aihub/shared";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "./migrations.ts";

/** A reader as the daemon stores it: with its sample files and the fingerprints that pin it. */
export interface StaffReaderRecord extends StaffReader {
  samples: Array<{ name: string; text: string }>;
  codeHash: string | null;
  /** The fingerprint of the code the operator approved. Only that code runs. */
  approvedHash: string | null;
}

/** An agent as the daemon stores it. The UI sees Agent, without the charter. */
export interface AgentRecord extends StaffProfile {
  id: string;
  role: AgentRole;
  managerId: string | null;
  profile: RunProfile;
  charter: string;
  avatar: string;
  status: "active" | "archived";
  hiredAt: string;
  /** The model it runs on. Null follows the office default. */
  model: string | null;
  /** Its reasoning level. Null follows the model's default. */
  effort: string | null;
}

export type NewAgent = Omit<AgentRecord, "status" | "hiredAt" | "avatar" | "title" | "description" | "workingStyle" | "model" | "effort"> &
  Partial<Pick<AgentRecord, "avatar" | "title" | "description" | "workingStyle" | "model" | "effort">>;

export interface ConversationRecord extends Conversation {
  /** The runtime context that caches this conversation. Disposable: it can be rebuilt from messages. */
  contextId: string | null;
  /** Fingerprint of the instructions and tools the context was started with. */
  contextFingerprint: string | null;
  /** The thread has taken in source data, so every later turn in it counts as source data. */
  sourceData: boolean;
  /** The last message the thread has taken in. Briefings and notices after it are news to it. */
  seenMessageId: number;
}

type Row = Record<string, SQLInputValue>;

const ACTIVE_STATES_SQL = ACTIVE_RUN_STATES.map((state) => `'${state}'`).join(", ");

/** SQLite is the memory (DESIGN.md › Design rules). Every write goes through here. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let next = version; next < MIGRATIONS.length; next++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next]!);
        this.db.exec(`PRAGMA user_version = ${next + 1}`);
      });
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  // Agents ------------------------------------------------------------------

  /** Creates the agent, or updates its charter and placement if it exists. The operator's profile edits stay. */
  upsertAgent(agent: NewAgent) {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, title, description, working_style, avatar, role, manager_id, profile, charter, status, created_at, model, effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET role = excluded.role, manager_id = excluded.manager_id,
           profile = excluded.profile, charter = excluded.charter,
           title = CASE WHEN agents.title = '' THEN excluded.title ELSE agents.title END,
           description = CASE WHEN agents.description = '' THEN excluded.description ELSE agents.description END,
           working_style = CASE WHEN agents.working_style = '' THEN excluded.working_style ELSE agents.working_style END`,
      )
      .run(
        agent.id,
        agent.name,
        agent.title ?? "",
        agent.description ?? "",
        agent.workingStyle ?? "",
        agent.avatar ?? agent.id,
        agent.role,
        agent.managerId,
        agent.profile,
        agent.charter,
        this.timestamp(),
        agent.model ?? null,
        agent.effort ?? null,
      );
  }

  /** The operator picks the model and reasoning level a staff member runs on. */
  setAgentModel(id: string, choice: { model: string | null; effort: string | null }) {
    this.db.prepare("UPDATE agents SET model = ?, effort = ? WHERE id = ?").run(choice.model, choice.effort, id);
  }

  /** The operator edits a staff member's profile. */
  updateProfile(id: string, profile: Partial<StaffProfile>): Agent | null {
    const current = this.getAgentRecord(id);
    if (!current) return null;
    const next = { ...current, ...profile };
    this.db
      .prepare("UPDATE agents SET name = ?, title = ?, description = ?, working_style = ? WHERE id = ?")
      .run(next.name, next.title, next.description, next.workingStyle, id);
    return this.getAgent(id);
  }

  /** Whether another active agent already uses the name. Names identify staff in chat and notes. */
  isNameTaken(name: string, exceptId?: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM agents WHERE status = 'active' AND lower(name) = lower(?) AND id <> ?")
      .get(name.trim(), exceptId ?? "") as Row | undefined;
    return row !== undefined;
  }

  /** A readable ID that is not taken yet, such as "work-schedule" or "work-schedule-2". */
  freeAgentId(base: string): string {
    const slug = base.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "staff";
    for (let n = 1; ; n++) {
      const id = n === 1 ? slug : `${slug}-${n}`;
      if (!this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id)) return id;
    }
  }

  countActive(role: AgentRole): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status = 'active' AND role = ?").get(role) as { n: number };
    return Number(row.n);
  }

  getAgentRecord(id: string): AgentRecord | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgentRecord(row) : null;
  }

  getAgent(id: string): Agent | null {
    return this.listAgents(id)[0] ?? null;
  }

  /** Active agents with the state of their current run. */
  listAgents(onlyId?: string): Agent[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, (
           SELECT r.state FROM runs r
           WHERE r.agent_id = a.id AND r.state IN (${ACTIVE_STATES_SQL})
           ORDER BY r.started_at IS NULL, r.queued_at LIMIT 1
         ) AS run_state,
         EXISTS (
           SELECT 1 FROM grants g JOIN connections c ON c.id = g.connection_id
           WHERE g.agent_id = a.id AND g.revoked_at IS NULL AND c.status <> 'connected'
         ) AS waiting,
         (a.role = 'supervisor'
           AND EXISTS (SELECT 1 FROM responsibilities r WHERE r.owner_id = a.id AND r.status = 'ended')
           AND NOT EXISTS (SELECT 1 FROM responsibilities r WHERE r.owner_id = a.id AND r.status = 'active')
         ) AS unassigned,
         (SELECT group_concat(g.connection_id, ' ') FROM grants g WHERE g.agent_id = a.id AND g.revoked_at IS NULL) AS connection_ids,
         (SELECT w.sites FROM web_grants w WHERE w.agent_id = a.id) AS web_sites,
         (SELECT COUNT(*) FROM results x WHERE x.agent_id = a.id)
           + (SELECT COUNT(*) FROM items i JOIN responsibilities r ON r.id = i.responsibility_id
              WHERE r.owner_id = a.id AND i.state = 'resolved') AS experience
         FROM agents a
         WHERE a.status = 'active' AND (? IS NULL OR a.id = ?)
         ORDER BY a.created_at, a.id`,
      )
      .all(onlyId ?? null, onlyId ?? null) as Row[];
    return rows.map((row) => {
      const { charter: _charter, status: _status, ...agent } = toAgentRecord(row);
      // A run in progress shows first; then missing access; then a supervisor whose responsibility ended.
      const state = (row.run_state as RunState | null) ?? (row.waiting ? "waiting_for_access" : row.unassigned ? "done" : "idle");
      const connectionIds = row.connection_ids ? String(row.connection_ids).split(" ") : [];
      const web = row.web_sites === null || row.web_sites === undefined ? null : { sites: JSON.parse(String(row.web_sites)) as string[] };
      return { ...agent, experience: Number(row.experience), state, connectionIds, web };
    });
  }

  // Conversations -----------------------------------------------------------

  ensureConversation(conversation: Conversation) {
    this.db
      .prepare("INSERT INTO conversations (id, agent_id, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
      .run(conversation.id, conversation.agentId, conversation.title, this.timestamp());
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  listConversations(): Conversation[] {
    const rows = this.db.prepare("SELECT * FROM conversations ORDER BY created_at, id").all() as Row[];
    return rows.map((row) => {
      const { contextId: _id, contextFingerprint: _fingerprint, sourceData: _data, seenMessageId: _seen, ...conversation } = toConversation(row);
      return conversation;
    });
  }

  setConversationContext(id: string, contextId: string | null, fingerprint: string | null) {
    this.db
      .prepare("UPDATE conversations SET context_id = ?, context_fingerprint = ? WHERE id = ?")
      .run(contextId, fingerprint, id);
  }

  /** Records what a conversation's thread has taken in. */
  setConversationThread(id: string, thread: { sourceData?: boolean; seenMessageId?: number }) {
    this.db
      .prepare(
        "UPDATE conversations SET source_data = COALESCE(?, source_data), seen_message_id = MAX(seen_message_id, COALESCE(?, 0)) WHERE id = ?",
      )
      .run(thread.sourceData === undefined ? null : thread.sourceData ? 1 : 0, thread.seenMessageId ?? null, id);
  }

  // Messages ----------------------------------------------------------------

  /** Records a message. `sourceData` marks one written from source data, such as a briefing. */
  addMessage(
    input: Omit<ChatMessage, "id" | "createdAt" | "kind" | "refId"> & { kind?: MessageKind; refId?: string | null; sourceData?: boolean },
  ): ChatMessage {
    const { sourceData, ...fields } = input;
    const message = { ...fields, kind: input.kind ?? "chat", refId: input.refId ?? null };
    const createdAt = this.timestamp();
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO messages (conversation_id, author, agent_id, kind, body, run_id, ref_id, source_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(message.conversationId, message.author, message.agentId, message.kind, message.body, message.runId, message.refId, sourceData ? 1 : 0, createdAt);
    return { ...message, id: Number(lastInsertRowid), createdAt };
  }

  /** A conversation's messages after one, oldest first, each saying whether it was written from source data. */
  messagesAfter(conversationId: string, afterId: number): Array<ChatMessage & { sourceData: boolean }> {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id").all(conversationId, afterId) as Row[];
    return rows.map((row) => ({ ...toMessage(row), sourceData: Number(row.source_data) === 1 }));
  }

  /** Which of these messages were written from source data. */
  sourceDataAmong(ids: number[]): Set<number> {
    if (!ids.length) return new Set();
    const rows = this.db
      .prepare(`SELECT id FROM messages WHERE source_data = 1 AND id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Row[];
    return new Set(rows.map((row) => Number(row.id)));
  }

  /** The newest message id in a conversation, or 0. */
  lastMessageId(conversationId: string): number {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?").get(conversationId) as Row;
    return Number(row.id ?? 0);
  }

  /** The latest messages of one conversation, or of every conversation, oldest first. */
  recentMessages(limit: number, conversationId?: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT m.*, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY id DESC) AS recency
           FROM messages m WHERE (? IS NULL OR conversation_id = ?)
         ) WHERE recency <= ? ORDER BY id`,
      )
      .all(conversationId ?? null, conversationId ?? null, limit) as Row[];
    return rows.map(toMessage);
  }

  // Runs --------------------------------------------------------------------

  createRun(run: { agentId: string; kind: RunKind; title: string; responsibilityId?: string | null; assignmentId?: string | null }): Run {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs (id, agent_id, responsibility_id, assignment_id, kind, title, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
      )
      .run(id, run.agentId, run.responsibilityId ?? null, run.assignmentId ?? null, run.kind, run.title, this.timestamp());
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  recentRuns(limit: number): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY queued_at DESC, rowid DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toRun);
  }

  /** Moves a run to a new state, stamping when it started and finished. */
  setRunState(id: string, state: RunState, error: string | null = null): Run {
    const at = this.timestamp();
    const finished = state === "done" || state === "failed";
    this.db
      .prepare(
        `UPDATE runs SET state = ?, error = COALESCE(?, error),
           started_at = CASE WHEN started_at IS NULL AND ? <> 'queued' THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END
         WHERE id = ?`,
      )
      .run(state, error, state, at, finished ? 1 : 0, at, id);
    return this.getRun(id)!;
  }

  /** Records one model turn and what it used. */
  /** Counts a turn and its usage, and records the model it ran on when the runtime said. */
  addTurn(id: string, usage: Usage | null, model?: { model: string; effort: string | null } | null): Run {
    this.db
      .prepare(
        `UPDATE runs SET turns = turns + 1, input_tokens = input_tokens + ?,
           cached_input_tokens = cached_input_tokens + ?, output_tokens = output_tokens + ?
         WHERE id = ?`,
      )
      .run(usage?.inputTokens ?? 0, usage?.cachedInputTokens ?? 0, usage?.outputTokens ?? 0, id);
    if (model) this.db.prepare("UPDATE runs SET model = ?, effort = ? WHERE id = ?").run(model.model, model.effort, id);
    return this.getRun(id)!;
  }

  /** Runs left in progress when the daemon stopped can't continue. Marks them failed and returns them. */
  failUnfinishedRuns(reason: string): Run[] {
    const ids = this.db.prepare(`SELECT id FROM runs WHERE state IN (${ACTIVE_STATES_SQL})`).all() as Array<{ id: string }>;
    return ids.map(({ id }) => this.setRunState(id, "failed", reason));
  }

  usageSince(since: Date): Usage & { turns: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(turns), 0) AS turns, COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(cached_input_tokens), 0) AS cached, COALESCE(SUM(output_tokens), 0) AS output
         FROM runs WHERE queued_at >= ?`,
      )
      .get(since.toISOString()) as Record<string, number>;
    return { turns: row.turns!, inputTokens: row.input!, cachedInputTokens: row.cached!, outputTokens: row.output! };
  }

  // Activity ----------------------------------------------------------------

  addActivity(entry: { agentId: string | null; runId: string | null; kind: ActivityKind; summary: string; detail?: unknown }): ActivityEntry {
    const at = this.timestamp();
    const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail);
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO activity (at, agent_id, run_id, kind, summary, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(at, entry.agentId, entry.runId, entry.kind, entry.summary, detail);
    return { id: Number(lastInsertRowid), at, agentId: entry.agentId, runId: entry.runId, kind: entry.kind, summary: entry.summary };
  }

  recentActivity(limit: number): ActivityEntry[] {
    const rows = this.db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      at: String(row.at),
      agentId: row.agent_id as string | null,
      runId: row.run_id as string | null,
      kind: row.kind as ActivityKind,
      summary: String(row.summary),
    }));
  }

  // Results -----------------------------------------------------------------

  /** Records a run's result. A run has at most one; returns false if it already has one. */
  addResult(result: { runId: string; agentId: string; summary: string; body: unknown }): boolean {
    const { changes } = this.db
      .prepare("INSERT INTO results (run_id, agent_id, summary, body, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id) DO NOTHING")
      .run(result.runId, result.agentId, result.summary, JSON.stringify(result.body), this.timestamp());
    return changes > 0;
  }

  resultForRun(runId: string): { summary: string; body: unknown; createdAt: string } | null {
    const row = this.db.prepare("SELECT summary, body, created_at FROM results WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? { summary: String(row.summary), body: JSON.parse(String(row.body)), createdAt: String(row.created_at) } : null;
  }

  /** When delivered briefings finished, newest first: the office's streak counts weekdays from them. */
  briefingDeliveries(limit = 60): string[] {
    const rows = this.db
      .prepare("SELECT finished_at FROM runs WHERE kind = 'briefing' AND state = 'done' ORDER BY finished_at DESC LIMIT ?")
      .all(limit) as Array<{ finished_at: string }>;
    return rows.map((row) => String(row.finished_at));
  }

  // Responsibilities --------------------------------------------------------

  createResponsibility(input: Omit<Responsibility, "id" | "status" | "endedAt">): Responsibility {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO responsibilities (id, owner_id, title, scope, standing_instructions, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(id, input.ownerId, input.title, input.scope, input.standingInstructions, input.expiresAt, this.timestamp());
    return this.getResponsibility(id)!;
  }

  getResponsibility(id: string): Responsibility | null {
    const row = this.db.prepare("SELECT * FROM responsibilities WHERE id = ?").get(id) as Row | undefined;
    return row ? toResponsibility(row) : null;
  }

  listResponsibilities(): Responsibility[] {
    return (this.db.prepare("SELECT * FROM responsibilities ORDER BY created_at, id").all() as Row[]).map(toResponsibility);
  }

  /** The agent's responsibility, if it is active and has not expired. */
  activeResponsibilityOf(agentId: string): Responsibility | null {
    const row = this.db
      .prepare(
        `SELECT * FROM responsibilities WHERE owner_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at LIMIT 1`,
      )
      .get(agentId, this.timestamp()) as Row | undefined;
    return row ? toResponsibility(row) : null;
  }

  /** Whether a responsibility still allows work: active and not past its expiry. */
  isResponsibilityActive(id: string): boolean {
    const responsibility = this.getResponsibility(id);
    return responsibility?.status === "active" && (responsibility.expiresAt === null || responsibility.expiresAt > this.timestamp());
  }

  endResponsibility(id: string): Responsibility | null {
    const { changes } = this.db
      .prepare("UPDATE responsibilities SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'")
      .run(this.timestamp(), id);
    return changes ? this.getResponsibility(id) : null;
  }

  /** Ends every responsibility whose expiry has passed and returns them. */
  endExpiredResponsibilities(): Responsibility[] {
    const rows = this.db
      .prepare("SELECT id FROM responsibilities WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(this.timestamp()) as Array<{ id: string }>;
    return rows.flatMap(({ id }) => this.endResponsibility(id) ?? []);
  }

  // Connections and grants --------------------------------------------------

  createConnection(input: { kind: SourceKind; label: string; path: string; pattern?: string | null; reader?: string | null }): SourceConnection {
    const id = crypto.randomUUID();
    const config = { path: input.path, pattern: input.pattern ?? null, reader: input.reader ?? null };
    this.db
      .prepare("INSERT INTO connections (id, kind, label, config, status, created_at) VALUES (?, ?, ?, ?, 'unverified', ?)")
      .run(id, input.kind, input.label, JSON.stringify(config), this.timestamp());
    return this.getConnection(id)!;
  }

  getConnection(id: string): SourceConnection | null {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    return row ? toConnection(row) : null;
  }

  listConnections(): SourceConnection[] {
    return (this.db.prepare("SELECT * FROM connections ORDER BY created_at, id").all() as Row[]).map(toConnection);
  }

  setConnectionStatus(id: string, status: SourceConnection["status"], detail: string | null): SourceConnection {
    this.db.prepare("UPDATE connections SET status = ?, detail = ?, verified_at = ? WHERE id = ?").run(status, detail, this.timestamp(), id);
    return this.getConnection(id)!;
  }

  grant(agentId: string, connectionId: string, operations: string[]) {
    this.db
      .prepare("INSERT INTO grants (agent_id, connection_id, operations, created_at) VALUES (?, ?, ?, ?)")
      .run(agentId, connectionId, JSON.stringify(operations), this.timestamp());
  }

  /** Takes back an agent's access to a connection. */
  revokeGrant(agentId: string, connectionId: string) {
    this.db
      .prepare("UPDATE grants SET revoked_at = ? WHERE agent_id = ? AND connection_id = ? AND revoked_at IS NULL")
      .run(this.timestamp(), agentId, connectionId);
  }

  /** A staff member leaves: off the roster, with every grant revoked. Its records and notes stay. */
  archiveAgent(id: string) {
    const now = this.timestamp();
    this.transaction(() => {
      this.db.prepare("UPDATE agents SET status = 'archived' WHERE id = ?").run(id);
      this.db.prepare("UPDATE grants SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(now, id);
      this.db.prepare("DELETE FROM web_grants WHERE agent_id = ?").run(id);
    });
  }

  // The office policy -------------------------------------------------------

  /** The policy staff work under: the newest approved version. */
  currentPolicy(): PolicyVersion | null {
    const row = this.db.prepare("SELECT * FROM policy_versions WHERE status = 'approved' ORDER BY decided_at DESC, id DESC LIMIT 1").get() as Row | undefined;
    return row ? toPolicy(row) : null;
  }

  getPolicy(id: number): PolicyVersion | null {
    const row = this.db.prepare("SELECT * FROM policy_versions WHERE id = ?").get(id) as Row | undefined;
    return row ? toPolicy(row) : null;
  }

  /** Versions and proposals, newest first. */
  listPolicies(limit = 20): PolicyVersion[] {
    return (this.db.prepare("SELECT * FROM policy_versions ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toPolicy);
  }

  pendingPolicies(): PolicyVersion[] {
    return (this.db.prepare("SELECT * FROM policy_versions WHERE status = 'pending' ORDER BY id").all() as Row[]).map(toPolicy);
  }

  /** Records a version: approved when the operator wrote it, pending when proposed. */
  addPolicy(input: { body: string; authorId: string | null; reason: string | null; basedOn: number | null; status: "approved" | "pending"; fromSourceData: boolean }): PolicyVersion {
    const at = this.timestamp();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO policy_versions (body, author_id, reason, based_on, status, from_source_data, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.body, input.authorId, input.reason, input.basedOn, input.status, input.fromSourceData ? 1 : 0, at, input.status === "approved" ? at : null);
    return this.getPolicy(Number(lastInsertRowid))!;
  }

  /** Decides a pending proposal. Returns null if it was no longer pending. */
  decidePolicy(id: number, status: "approved" | "declined" | "withdrawn", outcome: string | null): PolicyVersion | null {
    const { changes } = this.db
      .prepare("UPDATE policy_versions SET status = ?, outcome = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, outcome, this.timestamp(), id);
    return changes ? this.getPolicy(id) : null;
  }

  /** The web search a staff member holds, or null. */
  webGrantOf(agentId: string): WebGrant | null {
    const row = this.db.prepare("SELECT sites FROM web_grants WHERE agent_id = ?").get(agentId) as Row | undefined;
    return row ? { sites: JSON.parse(String(row.sites)) as string[] } : null;
  }

  /** Gives a staff member web search, or with null takes it away. */
  setWebGrant(agentId: string, grant: WebGrant | null) {
    if (!grant) {
      this.db.prepare("DELETE FROM web_grants WHERE agent_id = ?").run(agentId);
      return;
    }
    this.db
      .prepare("INSERT INTO web_grants (agent_id, sites, granted_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET sites = excluded.sites")
      .run(agentId, JSON.stringify(grant.sites), this.timestamp());
  }

  /** Connections the agent holds an unrevoked grant for. */
  connectionsOf(agentId: string): SourceConnection[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM connections c JOIN grants g ON g.connection_id = c.id
         WHERE g.agent_id = ? AND g.revoked_at IS NULL ORDER BY c.created_at`,
      )
      .all(agentId) as Row[];
    return rows.map(toConnection);
  }

  // Routines and occurrences ------------------------------------------------

  createRoutine(input: Omit<Routine, "id" | "paused" | "nextRunAt">): Routine {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO routines (id, owner_id, responsibility_id, title, trigger, timezone, daily_turn_budget, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.ownerId, input.responsibilityId, input.title, JSON.stringify(input.trigger), input.timezone, input.dailyTurnBudget, this.timestamp());
    return this.getRoutine(id)!;
  }

  getRoutine(id: string): Routine | null {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as Row | undefined;
    return row ? toRoutine(row) : null;
  }

  listRoutines(): Routine[] {
    return (this.db.prepare("SELECT * FROM routines ORDER BY created_at, id").all() as Row[]).map(toRoutine);
  }

  setRoutineTrigger(id: string, trigger: RoutineTrigger): Routine | null {
    this.db.prepare("UPDATE routines SET trigger = ? WHERE id = ?").run(JSON.stringify(trigger), id);
    return this.getRoutine(id);
  }

  setRoutinePaused(id: string, paused: boolean): Routine | null {
    this.db.prepare("UPDATE routines SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
    return this.getRoutine(id);
  }

  /** Records an occurrence once. Returns false if it already exists, which deduplicates triggers. */
  claimOccurrence(id: string, routineId: string, scheduledFor: string): boolean {
    const { changes } = this.db
      .prepare(
        "INSERT INTO occurrences (id, routine_id, scheduled_for, status, updated_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT (id) DO NOTHING",
      )
      .run(id, routineId, scheduledFor, this.timestamp());
    return changes > 0;
  }

  getOccurrence(id: string): Occurrence | null {
    const row = this.db.prepare("SELECT * FROM occurrences WHERE id = ?").get(id) as Row | undefined;
    return row ? toOccurrence(row) : null;
  }

  /**
   * Sets an occurrence's outcome. `attempts` adds to its count of attempts, such as -1 to give back
   * one that only waited. `retryAt` is when it runs again; left out, it won't.
   */
  updateOccurrence(
    id: string,
    update: { status: Occurrence["status"]; runId?: string | null; detail?: string | null; attempts?: number; retryAt?: string | null },
  ) {
    this.db
      .prepare(
        `UPDATE occurrences SET status = ?, run_id = COALESCE(?, run_id), detail = ?, attempts = MAX(attempts + ?, 0), retry_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(update.status, update.runId ?? null, update.detail ?? null, update.attempts ?? 0, update.retryAt ?? null, this.timestamp(), id);
  }

  /**
   * Starts an occurrence as it was read, counting the attempt. Returns false if it changed since,
   * such as when another scheduler started it first.
   */
  startOccurrence(occurrence: Occurrence): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE occurrences SET status = 'running', attempts = attempts + 1, retry_at = NULL, updated_at = ?
         WHERE id = ? AND status = ? AND updated_at = ?`,
      )
      .run(this.timestamp(), occurrence.id, occurrence.status, occurrence.updatedAt);
    return changes > 0;
  }

  occurrencesIn(status: Occurrence["status"]): Occurrence[] {
    return (this.db.prepare("SELECT * FROM occurrences WHERE status = ? ORDER BY scheduled_for").all(status) as Row[]).map(toOccurrence);
  }

  /**
   * Occurrences left running when the daemon stopped. Each fails, and runs again after `retryAfterMs`
   * if it has had fewer than `maxAttempts`.
   */
  failRunningOccurrences(reason: string, retryAfterMs: number, maxAttempts: number): number {
    const retryAt = new Date(this.now().getTime() + retryAfterMs).toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE occurrences SET status = 'failed', detail = ?, retry_at = CASE WHEN attempts < ? THEN ? END, updated_at = ?
         WHERE status = 'running'`,
      )
      .run(reason, maxAttempts, retryAt, this.timestamp());
    return Number(changes);
  }

  // Proposals ---------------------------------------------------------------

  createProposal(input: { proposedBy: string; runId: string | null; payload: RecruitProposal }): Proposal {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO proposals (id, kind, proposed_by, run_id, payload, status, created_at) VALUES (?, 'recruit_supervisor', ?, ?, ?, 'pending', ?)",
      )
      .run(id, input.proposedBy, input.runId, JSON.stringify(input.payload), this.timestamp());
    return this.getProposal(id)!;
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return row ? toProposal(row) : null;
  }

  /** Pending proposals and recent decisions, newest first. */
  listProposals(limit = 30): Proposal[] {
    const rows = this.db
      .prepare("SELECT * FROM proposals ORDER BY status = 'pending' DESC, created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(toProposal);
  }

  /** Records the decision on a pending proposal. Returns null if it was already decided. */
  decideProposal(id: string, status: "approved" | "declined", outcome: string): Proposal | null {
    const { changes } = this.db
      .prepare("UPDATE proposals SET status = ?, outcome = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, outcome, this.timestamp(), id);
    return changes ? this.getProposal(id) : null;
  }

  // Cursors -----------------------------------------------------------------

  getCursor(responsibilityId: string, connectionId: string): unknown {
    const row = this.db
      .prepare("SELECT position FROM cursors WHERE responsibility_id = ? AND connection_id = ?")
      .get(responsibilityId, connectionId) as { position: string } | undefined;
    return row ? JSON.parse(row.position) : null;
  }

  setCursor(responsibilityId: string, connectionId: string, position: unknown) {
    this.db
      .prepare(
        `INSERT INTO cursors (responsibility_id, connection_id, position, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (responsibility_id, connection_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
      )
      .run(responsibilityId, connectionId, JSON.stringify(position), this.timestamp());
  }

  // Items -------------------------------------------------------------------

  /**
   * Records a finding from a source record. The same record is one item: reporting it again with the
   * same source version changes nothing, so an unchanged item is never new twice and a dismissed one
   * stays dismissed. A new source version makes it new again, even if it was dismissed or resolved.
   */
  upsertItem(input: {
    responsibilityId: string;
    sourceKey: string;
    sourceVersion: string;
    title: string;
    detail: string;
    urgency: Urgency;
    expiresAt: string | null;
  }): { item: Item; change: "new" | "changed" | "unchanged" } {
    const at = this.timestamp();
    const existing = this.db
      .prepare("SELECT * FROM items WHERE responsibility_id = ? AND source_key = ?")
      .get(input.responsibilityId, input.sourceKey) as Row | undefined;
    if (!existing) {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO items (responsibility_id, source_key, source_version, title, detail, urgency, state, first_seen_at, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
        )
        .run(input.responsibilityId, input.sourceKey, input.sourceVersion, input.title, input.detail, input.urgency, at, input.expiresAt, at);
      return { item: this.getItem(Number(lastInsertRowid))!, change: "new" };
    }
    if (existing.source_version === input.sourceVersion) return { item: toItem(existing), change: "unchanged" };
    this.db
      .prepare(
        `UPDATE items SET source_version = ?, title = ?, detail = ?, urgency = ?, state = 'new', resolution = NULL,
           expires_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(input.sourceVersion, input.title, input.detail, input.urgency, input.expiresAt, at, Number(existing.id));
    return { item: this.getItem(Number(existing.id))!, change: "changed" };
  }

  getItem(id: number): Item | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** The item a source record became, if any. */
  findItem(responsibilityId: string, sourceKey: string): (Item & { sourceVersion: string }) | null {
    const row = this.db
      .prepare("SELECT * FROM items WHERE responsibility_id = ? AND source_key = ?")
      .get(responsibilityId, sourceKey) as Row | undefined;
    return row ? { ...toItem(row), sourceVersion: String(row.source_version) } : null;
  }

  /** Items of a responsibility in the given states, oldest first. */
  itemsOf(responsibilityId: string, states: ItemState[]): Item[] {
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE responsibility_id = ? AND state IN (${states.map(() => "?").join(", ")}) ORDER BY id`)
      .all(responsibilityId, ...states) as Row[];
    return rows.map(toItem);
  }

  /** Items of a responsibility closed since a time, such as the last briefing. */
  closedItemsSince(responsibilityId: string, since: string): Item[] {
    const rows = this.db
      .prepare("SELECT * FROM items WHERE responsibility_id = ? AND state = 'resolved' AND updated_at > ? ORDER BY id")
      .all(responsibilityId, since) as Row[];
    return rows.map(toItem);
  }

  /** New and open items, then the most recently closed ones. */
  listItems(closedLimit = 50): Item[] {
    const open = this.db.prepare("SELECT * FROM items WHERE state IN ('new', 'open') ORDER BY id DESC").all() as Row[];
    const closed = this.db
      .prepare("SELECT * FROM items WHERE state IN ('resolved', 'dismissed') ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(closedLimit) as Row[];
    return [...open, ...closed].map(toItem);
  }

  /** After a briefing is delivered: its new items become open. */
  markReported(ids: number[]): Item[] {
    const at = this.timestamp();
    const update = this.db.prepare(
      "UPDATE items SET state = CASE WHEN state = 'new' THEN 'open' ELSE state END, last_reported_at = ?, updated_at = ? WHERE id = ?",
    );
    return ids.map((id) => {
      update.run(at, at, id);
      return this.getItem(id)!;
    });
  }

  /** The operator dismisses or resolves an item. Returns null if it is already closed. */
  closeItem(id: number, state: "dismissed" | "resolved", resolution: string | null): Item | null {
    const { changes } = this.db
      .prepare("UPDATE items SET state = ?, resolution = ?, updated_at = ? WHERE id = ? AND state IN ('new', 'open')")
      .run(state, resolution, this.timestamp(), id);
    return changes ? this.getItem(id) : null;
  }

  /** Resolves new and open items whose source record has stopped mattering, such as a past event. */
  resolveExpiredItems(resolution: string): Item[] {
    const rows = this.db
      .prepare("SELECT id FROM items WHERE state IN ('new', 'open') AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(this.timestamp()) as Array<{ id: number }>;
    return rows.flatMap(({ id }) => this.closeItem(Number(id), "resolved", resolution) ?? []);
  }

  // Readers staff write ------------------------------------------------------

  createReader(input: { name: string; format: string; pattern: string; samples: Array<{ name: string; text: string }>; requesterId: string }): StaffReaderRecord {
    const id = crypto.randomUUID();
    const now = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO readers (id, name, format, pattern, samples, status, requester_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'drafting', ?, ?, ?)`,
      )
      .run(id, input.name, input.format, input.pattern, JSON.stringify(input.samples), input.requesterId, now, now);
    return this.getReader(id)!;
  }

  getReader(id: string): StaffReaderRecord | null {
    const row = this.db.prepare("SELECT * FROM readers WHERE id = ?").get(id) as Row | undefined;
    return row ? toReader(row) : null;
  }

  /** The newest reader with this name, ignoring case. */
  findReader(name: string): StaffReaderRecord | null {
    const row = this.db.prepare("SELECT * FROM readers WHERE lower(name) = lower(?) ORDER BY created_at DESC, id LIMIT 1").get(name.trim()) as Row | undefined;
    return row ? toReader(row) : null;
  }

  /** The reader a toolsmith is writing, if it is writing one. */
  draftReaderOf(authorId: string): StaffReaderRecord | null {
    const row = this.db.prepare("SELECT * FROM readers WHERE author_id = ? AND status = 'drafting'").get(authorId) as Row | undefined;
    return row ? toReader(row) : null;
  }

  listReaders(limit = 50): StaffReader[] {
    const rows = this.db.prepare("SELECT * FROM readers ORDER BY created_at DESC, id LIMIT ?").all(limit) as Row[];
    return rows.map((row) => {
      const { samples: _samples, codeHash: _code, approvedHash: _approved, ...reader } = toReader(row);
      return reader;
    });
  }

  countReaders(statuses: StaffReaderStatus[]): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM readers WHERE status IN (${statuses.map(() => "?").join(", ")})`).get(...statuses) as { n: number };
    return Number(row.n);
  }

  setReaderAuthor(id: string, author: { id: string; name: string }, assignmentId: string): StaffReaderRecord {
    this.db.prepare("UPDATE readers SET author_id = ?, author_name = ?, assignment_id = ?, updated_at = ? WHERE id = ?").run(author.id, author.name, assignmentId, this.timestamp(), id);
    return this.getReader(id)!;
  }

  /** The toolsmith hands in its code. It waits for the operator's approval before it runs on real files. */
  submitReaderCode(id: string, code: string, notes: string): StaffReaderRecord {
    this.db
      .prepare("UPDATE readers SET code = ?, code_hash = ?, notes = ?, status = 'proposed', updated_at = ? WHERE id = ? AND status = 'drafting'")
      .run(code, codeHash(code), notes, this.timestamp(), id);
    return this.getReader(id)!;
  }

  /** Pins the reader's current code as the one the operator approved. */
  approveReader(id: string): StaffReaderRecord {
    const now = this.timestamp();
    this.db
      .prepare("UPDATE readers SET status = 'approved', approved_hash = code_hash, approved_at = coalesce(approved_at, ?), updated_at = ? WHERE id = ? AND status IN ('proposed', 'approved')")
      .run(now, now, id);
    return this.getReader(id)!;
  }

  failReader(id: string): StaffReaderRecord | null {
    this.db.prepare("UPDATE readers SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'drafting'").run(this.timestamp(), id);
    return this.getReader(id);
  }

  // Assignments -------------------------------------------------------------

  createAssignment(input: {
    kind: AssignmentKind;
    requesterId: string;
    ownerId: string;
    parentId: string | null;
    conversationId: string | null;
    responsibilityId: string | null;
    title: string;
    brief: string;
    runBudget: number;
  }): Assignment {
    const id = crypto.randomUUID();
    const now = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO assignments (id, kind, requester_id, owner_id, parent_id, conversation_id, responsibility_id, title, brief, status, run_budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(id, input.kind, input.requesterId, input.ownerId, input.parentId, input.conversationId, input.responsibilityId, input.title, input.brief, input.runBudget, now, now);
    return this.getAssignment(id)!;
  }

  getAssignment(id: string): (Assignment & { responsibilityId: string | null }) | null {
    const row = this.db.prepare(`${ASSIGNMENT_SELECT} WHERE x.id = ?`).get(id) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  /** Open and waiting assignments, then the most recent settled ones, newest first. */
  listAssignments(recent = 30): Assignment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (${ASSIGNMENT_SELECT} WHERE x.status IN ('open', 'waiting'))
         UNION ALL
         SELECT * FROM (${ASSIGNMENT_SELECT} WHERE x.status NOT IN ('open', 'waiting') ORDER BY x.updated_at DESC, x.id LIMIT ?)`,
      )
      .all(recent) as Row[];
    const open = (row: Row) => row.status === "open" || row.status === "waiting";
    return rows
      .sort((a, b) => Number(open(b)) - Number(open(a)) || String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((row) => {
        const { responsibilityId: _responsibility, ...assignment } = toAssignment(row);
        return assignment;
      });
  }

  childrenOf(parentId: string): Array<Assignment & { responsibilityId: string | null }> {
    const rows = this.db.prepare(`${ASSIGNMENT_SELECT} WHERE x.parent_id = ? ORDER BY x.created_at, x.id`).all(parentId) as Row[];
    return rows.map(toAssignment);
  }

  /** Assignments in these states, such as open ones to pick up after a restart. */
  assignmentsIn(statuses: AssignmentStatus[]): Array<Assignment & { responsibilityId: string | null }> {
    const rows = this.db
      .prepare(`${ASSIGNMENT_SELECT} WHERE x.status IN (${statuses.map(() => "?").join(", ")}) ORDER BY x.created_at, x.id`)
      .all(...statuses) as Row[];
    return rows.map(toAssignment);
  }

  countAssignments(filter: { requesterId?: string; ownerId?: string; kind?: AssignmentKind; statuses: AssignmentStatus[] }): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM assignments
         WHERE status IN (${filter.statuses.map(() => "?").join(", ")})
           AND (? IS NULL OR requester_id = ?) AND (? IS NULL OR owner_id = ?) AND (? IS NULL OR kind = ?)`,
      )
      .get(
        ...filter.statuses,
        filter.requesterId ?? null,
        filter.requesterId ?? null,
        filter.ownerId ?? null,
        filter.ownerId ?? null,
        filter.kind ?? null,
        filter.kind ?? null,
      ) as { n: number };
    return Number(row.n);
  }

  updateAssignment(id: string, update: { status?: AssignmentStatus; result?: string | null; review?: string | null; runStarted?: boolean }) {
    this.db
      .prepare(
        `UPDATE assignments SET
           status = COALESCE(?, status),
           result = CASE WHEN ? THEN ? ELSE result END,
           review = CASE WHEN ? THEN ? ELSE review END,
           runs_used = runs_used + ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        update.status ?? null,
        update.result !== undefined ? 1 : 0,
        update.result ?? null,
        update.review !== undefined ? 1 : 0,
        update.review ?? null,
        update.runStarted ? 1 : 0,
        this.timestamp(),
        id,
      );
    return this.getAssignment(id)!;
  }

  // Views -------------------------------------------------------------------

  addView(view: Pick<View, "kind" | "agentId" | "runId" | "title" | "program" | "outside">): View {
    const id = crypto.randomUUID();
    const at = this.timestamp();
    this.db
      .prepare("INSERT INTO views (id, kind, agent_id, run_id, title, program, outside, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, view.kind, view.agentId, view.runId, view.title, view.program, view.outside, at, at);
    return this.getView(id)!;
  }

  getView(id: string): View | null {
    const row = this.db.prepare("SELECT * FROM views WHERE id = ?").get(id) as Row | undefined;
    return row ? toView(row) : null;
  }

  /** A new version of a view, such as a dashboard its author changed. */
  updateView(id: string, update: Pick<View, "runId" | "title" | "program">): View {
    this.db.prepare("UPDATE views SET run_id = ?, title = ?, program = ?, updated_at = ? WHERE id = ?").run(update.runId, update.title, update.program, this.timestamp(), id);
    return this.getView(id)!;
  }

  viewsOfRun(runId: string): View[] {
    return (this.db.prepare("SELECT * FROM views WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Row[]).map(toView);
  }

  /** Puts the views the runs handed in, and haven't shown yet, under a posted message. */
  attachViews(runIds: string[], messageId: number): View[] {
    if (!runIds.length) return [];
    const marks = runIds.map(() => "?").join(", ");
    this.db.prepare(`UPDATE views SET message_id = ? WHERE kind <> 'dashboard' AND message_id IS NULL AND run_id IN (${marks})`).run(messageId, ...runIds);
    return (this.db.prepare("SELECT * FROM views WHERE message_id = ? ORDER BY created_at, rowid").all(messageId) as Row[]).map(toView);
  }

  dashboards(): View[] {
    return (this.db.prepare("SELECT * FROM views WHERE kind = 'dashboard' ORDER BY updated_at DESC, rowid DESC").all() as Row[]).map(toView);
  }

  findDashboard(agentId: string, title: string): View | null {
    const row = this.db.prepare("SELECT * FROM views WHERE kind = 'dashboard' AND agent_id = ? AND title = ? COLLATE NOCASE").get(agentId, title) as Row | undefined;
    return row ? toView(row) : null;
  }

  /** Dashboards, and the views under the given messages. */
  listViews(messageIds: number[]): View[] {
    const marks = messageIds.map(() => "?").join(", ");
    const shown = messageIds.length
      ? (this.db.prepare(`SELECT * FROM views WHERE message_id IN (${marks}) ORDER BY created_at, rowid`).all(...messageIds) as Row[]).map(toView)
      : [];
    return [...this.dashboards(), ...shown];
  }

  removeView(id: string): boolean {
    return this.db.prepare("DELETE FROM views WHERE id = ?").run(id).changes > 0;
  }

  // Office data for dashboards ------------------------------------------------

  /** Items, newest first, optionally of some responsibilities, in some states, or first seen since a time. */
  queryItems(filter: { responsibilityIds?: string[]; states: ItemState[]; since?: string; limit: number }): Item[] {
    const where = [`state IN (${filter.states.map(() => "?").join(", ")})`];
    const values: SQLInputValue[] = [...filter.states];
    if (filter.responsibilityIds) {
      if (!filter.responsibilityIds.length) return [];
      where.push(`responsibility_id IN (${filter.responsibilityIds.map(() => "?").join(", ")})`);
      values.push(...filter.responsibilityIds);
    }
    if (filter.since) {
      where.push("first_seen_at >= ?");
      values.push(filter.since);
    }
    const rows = this.db.prepare(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY first_seen_at DESC, id DESC LIMIT ?`).all(...values, filter.limit) as Row[];
    return rows.map(toItem);
  }

  /** Runs queued since a time, newest first, optionally of one agent or kind. */
  queryRuns(filter: { agentId?: string; kind?: RunKind; since: string; limit: number }): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE queued_at >= ? AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR kind = ?)
         ORDER BY queued_at DESC, rowid DESC LIMIT ?`,
      )
      .all(filter.since, filter.agentId ?? null, filter.agentId ?? null, filter.kind ?? null, filter.kind ?? null, filter.limit) as Row[];
    return rows.map(toRun);
  }

  /** Assignments created since a time, newest first. */
  assignmentsSince(since: string): Assignment[] {
    const rows = this.db.prepare(`${ASSIGNMENT_SELECT} WHERE x.created_at >= ? ORDER BY x.created_at DESC, x.id`).all(since) as Row[];
    return rows.map(toAssignment);
  }

  // Settings ----------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}

function toAgentRecord(row: Row): AgentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    title: String(row.title),
    description: String(row.description),
    workingStyle: String(row.working_style),
    avatar: String(row.avatar) || String(row.id),
    role: row.role as AgentRole,
    managerId: row.manager_id as string | null,
    profile: row.profile as RunProfile,
    charter: String(row.charter),
    status: row.status as AgentRecord["status"],
    hiredAt: String(row.created_at),
    model: (row.model as string | null) ?? null,
    effort: (row.effort as string | null) ?? null,
  };
}

function toConversation(row: Row): ConversationRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    title: String(row.title),
    contextId: row.context_id as string | null,
    contextFingerprint: row.context_fingerprint as string | null,
    sourceData: Number(row.source_data) === 1,
    seenMessageId: Number(row.seen_message_id ?? 0),
  };
}

function toMessage(row: Row): ChatMessage {
  return {
    id: Number(row.id),
    conversationId: String(row.conversation_id),
    author: row.author as ChatMessage["author"],
    agentId: row.agent_id as string | null,
    kind: row.kind as MessageKind,
    body: String(row.body),
    runId: row.run_id as string | null,
    refId: row.ref_id as string | null,
    createdAt: String(row.created_at),
  };
}

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    responsibilityId: row.responsibility_id as string | null,
    assignmentId: row.assignment_id as string | null,
    kind: row.kind as RunKind,
    title: String(row.title),
    state: row.state as RunState,
    turns: Number(row.turns),
    usage: {
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
    },
    error: row.error as string | null,
    queuedAt: String(row.queued_at),
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
    model: (row.model as string | null) ?? null,
    effort: (row.effort as string | null) ?? null,
  };
}

export interface Occurrence {
  id: string;
  routineId: string;
  scheduledFor: string;
  status: "pending" | "running" | "waiting" | "delivered" | "failed" | "skipped";
  attempts: number;
  runId: string | null;
  detail: string | null;
  /** When a waiting or failed occurrence runs again. Null means it won't. */
  retryAt: string | null;
  updatedAt: string;
}

function toOccurrence(row: Row): Occurrence {
  return {
    id: String(row.id),
    routineId: String(row.routine_id),
    scheduledFor: String(row.scheduled_for),
    status: row.status as Occurrence["status"],
    attempts: Number(row.attempts),
    runId: row.run_id as string | null,
    detail: row.detail as string | null,
    retryAt: row.retry_at as string | null,
    updatedAt: String(row.updated_at),
  };
}

function toResponsibility(row: Row): Responsibility {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    scope: String(row.scope),
    standingInstructions: String(row.standing_instructions),
    expiresAt: row.expires_at as string | null,
    status: row.status as Responsibility["status"],
    endedAt: row.ended_at as string | null,
  };
}

function toConnection(row: Row): SourceConnection {
  const config = JSON.parse(String(row.config)) as { path: string; pattern?: string | null; reader?: string | null };
  return {
    id: String(row.id),
    kind: row.kind as SourceKind,
    label: String(row.label),
    path: config.path,
    pattern: config.pattern ?? null,
    reader: config.reader ?? null,
    status: row.status as SourceConnection["status"],
    detail: row.detail as string | null,
    verifiedAt: row.verified_at as string | null,
  };
}

function toPolicy(row: Row): PolicyVersion {
  return {
    id: Number(row.id),
    body: String(row.body),
    authorId: row.author_id as string | null,
    reason: row.reason as string | null,
    basedOn: row.based_on === null ? null : Number(row.based_on),
    status: String(row.status) as PolicyVersion["status"],
    fromSourceData: Number(row.from_source_data) === 1,
    outcome: row.outcome as string | null,
    createdAt: String(row.created_at),
    decidedAt: row.decided_at as string | null,
  };
}

function toRoutine(row: Row): Routine {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    responsibilityId: row.responsibility_id as string | null,
    title: String(row.title),
    trigger: JSON.parse(String(row.trigger)) as RoutineTrigger,
    timezone: String(row.timezone),
    dailyTurnBudget: Number(row.daily_turn_budget),
    paused: Boolean(row.paused),
    nextRunAt: null,
  };
}

function toProposal(row: Row): Proposal {
  return {
    id: String(row.id),
    kind: "recruit_supervisor",
    proposedBy: String(row.proposed_by),
    payload: JSON.parse(String(row.payload)) as RecruitProposal,
    status: row.status as Proposal["status"],
    outcome: row.outcome as string | null,
    createdAt: String(row.created_at),
    decidedAt: row.decided_at as string | null,
  };
}

export function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function toReader(row: Row): StaffReaderRecord {
  const samples = JSON.parse(String(row.samples)) as Array<{ name: string; text: string }>;
  return {
    id: String(row.id),
    name: String(row.name),
    format: String(row.format),
    pattern: String(row.pattern),
    sampleNames: samples.map((sample) => sample.name),
    samples,
    status: row.status as StaffReaderStatus,
    code: row.code as string | null,
    codeHash: row.code_hash as string | null,
    approvedHash: row.approved_hash as string | null,
    notes: row.notes as string | null,
    authorId: row.author_id as string | null,
    authorName: row.author_name as string | null,
    requesterId: String(row.requester_id),
    assignmentId: row.assignment_id as string | null,
    approvedAt: row.approved_at as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const ASSIGNMENT_SELECT = `SELECT x.*, r.name AS requester_name, o.name AS owner_name
  FROM assignments x JOIN agents r ON r.id = x.requester_id JOIN agents o ON o.id = x.owner_id`;

function toAssignment(row: Row): Assignment & { responsibilityId: string | null } {
  return {
    id: String(row.id),
    kind: row.kind as AssignmentKind,
    requesterId: String(row.requester_id),
    requesterName: String(row.requester_name),
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name),
    parentId: row.parent_id as string | null,
    conversationId: row.conversation_id as string | null,
    responsibilityId: row.responsibility_id as string | null,
    title: String(row.title),
    brief: String(row.brief),
    status: row.status as AssignmentStatus,
    runBudget: Number(row.run_budget),
    runsUsed: Number(row.runs_used),
    result: row.result as string | null,
    review: row.review as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toView(row: Row): View {
  return {
    id: String(row.id),
    kind: row.kind as View["kind"],
    agentId: String(row.agent_id),
    runId: (row.run_id as string | null) ?? null,
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
    title: String(row.title),
    program: String(row.program),
    outside: row.outside === "load" ? "load" : "ask",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toItem(row: Row): Item {
  return {
    id: Number(row.id),
    responsibilityId: String(row.responsibility_id),
    sourceKey: String(row.source_key),
    title: String(row.title),
    detail: String(row.detail),
    urgency: row.urgency as Urgency,
    state: row.state as ItemState,
    firstSeenAt: String(row.first_seen_at),
    lastReportedAt: row.last_reported_at as string | null,
    resolution: row.resolution as string | null,
    updatedAt: String(row.updated_at),
  };
}
