import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ACTIVE_RUN_STATES,
  type ActivityEntry,
  type ActivityKind,
  type Agent,
  type AgentRole,
  type ChatMessage,
  type Conversation,
  type Run,
  type RunKind,
  type RunProfile,
  type RunState,
  type Usage,
} from "@aihub/shared";
import { MIGRATIONS } from "./migrations.ts";

/** An agent as the daemon stores it. The UI sees the narrower Agent. */
export interface AgentRecord {
  id: string;
  name: string;
  role: AgentRole;
  managerId: string | null;
  profile: RunProfile;
  charter: string;
  status: "active" | "archived";
}

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

  /** Creates the agent, or updates its name, charter, and placement if it exists. */
  upsertAgent(agent: Omit<AgentRecord, "status">) {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, manager_id, profile, charter, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role,
           manager_id = excluded.manager_id, profile = excluded.profile, charter = excluded.charter`,
      )
      .run(agent.id, agent.name, agent.role, agent.managerId, agent.profile, agent.charter, this.timestamp());
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
         ) AS run_state
         FROM agents a
         WHERE a.status = 'active' AND (? IS NULL OR a.id = ?)
         ORDER BY a.created_at, a.id`,
      )
      .all(onlyId ?? null, onlyId ?? null) as Row[];
    return rows.map((row) => {
      const { charter: _charter, status: _status, ...agent } = toAgentRecord(row);
      return { ...agent, state: (row.run_state as RunState | null) ?? "idle" };
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

  addMessage(message: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
    const createdAt = this.timestamp();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO messages (conversation_id, author, agent_id, body, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.conversationId, message.author, message.agentId, message.body, message.runId, createdAt);
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

  createRun(run: { agentId: string; kind: RunKind; title: string }): Run {
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO runs (id, agent_id, kind, title, state, queued_at) VALUES (?, ?, ?, ?, 'queued', ?)")
      .run(id, run.agentId, run.kind, run.title, this.timestamp());
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
    role: row.role as AgentRole,
    managerId: row.manager_id as string | null,
    profile: row.profile as RunProfile,
    charter: String(row.charter),
    status: row.status as AgentRecord["status"],
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
    body: String(row.body),
    runId: row.run_id as string | null,
    createdAt: String(row.created_at),
  };
}

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
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
