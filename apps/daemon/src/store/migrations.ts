// Schema migrations, applied in order. `PRAGMA user_version` records how many have run.
// Never edit a migration that has shipped; add a new one.

export const MIGRATIONS: string[] = [
  // v1: the Chief of Staff chat, runs, and the activity feed (Milestone 1).
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('chief_of_staff', 'supervisor', 'worker')),
    manager_id TEXT REFERENCES agents (id),
    profile TEXT NOT NULL CHECK (profile IN ('data', 'conversation', 'workspace')),
    charter TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX runs_by_agent ON runs (agent_id, state);
  CREATE INDEX runs_by_queued_at ON runs (queued_at);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    title TEXT NOT NULL,
    context_id TEXT,
    context_fingerprint TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations (id),
    author TEXT NOT NULL CHECK (author IN ('operator', 'agent')),
    agent_id TEXT REFERENCES agents (id),
    body TEXT NOT NULL,
    run_id TEXT REFERENCES runs (id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_by_conversation ON messages (conversation_id, id);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    agent_id TEXT REFERENCES agents (id),
    run_id TEXT REFERENCES runs (id),
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v2: results, the reports runs submit through the gateway (DESIGN.md › Staff and work model).
  `
  CREATE TABLE results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
    agent_id TEXT NOT NULL REFERENCES agents (id),
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
];
