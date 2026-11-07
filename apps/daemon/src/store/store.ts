import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ACTIVE_RUN_STATES,
  type ActivityEntry,
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
  type RoutineTrigger,
  type Run,
  type RunKind,
  type RunProfile,
  type RunState,
  type SourceConnection,
  type SourceKind,
  type StaffProfile,
  type Urgency,
  type Usage,
} from "@aihub/shared";
import { MIGRATIONS } from "./migrations.ts";

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
}

export type NewAgent = Omit<AgentRecord, "status" | "hiredAt" | "avatar" | "title" | "description" | "workingStyle"> &
  Partial<Pick<AgentRecord, "avatar" | "title" | "description" | "workingStyle">>;

export interface ConversationRecord extends Conversation {
  /** The runtime context that caches this conversation. Disposable: it can be rebuilt from messages. */
  contextId: string | null;
  /** Fingerprint of the instructions and tools the context was started with. */
  contextFingerprint: string | null;
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
        `INSERT INTO agents (id, name, title, description, working_style, avatar, role, manager_id, profile, charter, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
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
      );
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
      return { ...agent, experience: Number(row.experience), state };
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
      const { contextId: _id, contextFingerprint: _fingerprint, ...conversation } = toConversation(row);
      return conversation;
    });
  }

  setConversationContext(id: string, contextId: string | null, fingerprint: string | null) {
    this.db
      .prepare("UPDATE conversations SET context_id = ?, context_fingerprint = ? WHERE id = ?")
      .run(contextId, fingerprint, id);
  }

  // Messages ----------------------------------------------------------------

  addMessage(input: Omit<ChatMessage, "id" | "createdAt" | "kind" | "refId"> & { kind?: MessageKind; refId?: string | null }): ChatMessage {
    const message = { ...input, kind: input.kind ?? "chat", refId: input.refId ?? null };
    const createdAt = this.timestamp();
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO messages (conversation_id, author, agent_id, kind, body, run_id, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(message.conversationId, message.author, message.agentId, message.kind, message.body, message.runId, message.refId, createdAt);
    return { ...message, id: Number(lastInsertRowid), createdAt };
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

  createRun(run: { agentId: string; kind: RunKind; title: string; responsibilityId?: string | null }): Run {
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO runs (id, agent_id, responsibility_id, kind, title, state, queued_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
      .run(id, run.agentId, run.responsibilityId ?? null, run.kind, run.title, this.timestamp());
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
  addTurn(id: string, usage: Usage | null): Run {
    this.db
      .prepare(
        `UPDATE runs SET turns = turns + 1, input_tokens = input_tokens + ?,
           cached_input_tokens = cached_input_tokens + ?, output_tokens = output_tokens + ?
         WHERE id = ?`,
      )
      .run(usage?.inputTokens ?? 0, usage?.cachedInputTokens ?? 0, usage?.outputTokens ?? 0, id);
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

  createConnection(input: { kind: SourceKind; label: string; path: string }): SourceConnection {
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO connections (id, kind, label, config, status, created_at) VALUES (?, ?, ?, ?, 'unverified', ?)")
      .run(id, input.kind, input.label, JSON.stringify({ path: input.path }), this.timestamp());
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

  updateOccurrence(id: string, update: { status: Occurrence["status"]; runId?: string | null; detail?: string | null; attempt?: boolean }) {
    this.db
      .prepare(
        `UPDATE occurrences SET status = ?, run_id = COALESCE(?, run_id), detail = ?, attempts = attempts + ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(update.status, update.runId ?? null, update.detail ?? null, update.attempt ? 1 : 0, this.timestamp(), id);
  }

  /** Occurrences left running when the daemon stopped. */
  failRunningOccurrences(reason: string): number {
    const { changes } = this.db
      .prepare("UPDATE occurrences SET status = 'failed', detail = ?, updated_at = ? WHERE status = 'running'")
      .run(reason, this.timestamp());
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
  };
}

function toConversation(row: Row): ConversationRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    title: String(row.title),
    contextId: row.context_id as string | null,
    contextFingerprint: row.context_fingerprint as string | null,
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
  };
}

export interface Occurrence {
  id: string;
  routineId: string;
  scheduledFor: string;
  status: "pending" | "running" | "delivered" | "failed" | "skipped";
  attempts: number;
  runId: string | null;
  detail: string | null;
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
  const config = JSON.parse(String(row.config)) as { path: string };
  return {
    id: String(row.id),
    kind: row.kind as SourceKind,
    label: String(row.label),
    path: config.path,
    status: row.status as SourceConnection["status"],
    detail: row.detail as string | null,
    verifiedAt: row.verified_at as string | null,
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
