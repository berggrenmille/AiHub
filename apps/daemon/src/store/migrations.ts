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

  // v3: staff profiles, responsibilities, sources, routines, proposals, and items (Milestone 2).
  `
  ALTER TABLE agents ADD COLUMN title TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN working_style TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
  -- The Chief of Staff of a Milestone 1 install gets its character name.
  UPDATE agents SET name = 'Vera' WHERE id = 'chief-of-staff' AND name = 'Chief of Staff';

  CREATE TABLE responsibilities (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES agents (id),
    title TEXT NOT NULL,
    scope TEXT NOT NULL,
    standing_instructions TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
    created_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('unverified', 'connected', 'failed')),
    detail TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    connection_id TEXT NOT NULL REFERENCES connections (id),
    operations TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES agents (id),
    responsibility_id TEXT REFERENCES responsibilities (id),
    title TEXT NOT NULL,
    trigger TEXT NOT NULL,
    timezone TEXT NOT NULL,
    daily_turn_budget INTEGER NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE occurrences (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines (id),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'delivered', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_id TEXT REFERENCES runs (id),
    detail TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    proposed_by TEXT NOT NULL REFERENCES agents (id),
    run_id TEXT REFERENCES runs (id),
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
    outcome TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE cursors (
    responsibility_id TEXT NOT NULL REFERENCES responsibilities (id),
    connection_id TEXT NOT NULL REFERENCES connections (id),
    position TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (responsibility_id, connection_id)
  );

  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    responsibility_id TEXT NOT NULL REFERENCES responsibilities (id),
    source_key TEXT NOT NULL,
    source_version TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    urgency TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('new', 'open', 'resolved', 'dismissed')),
    first_seen_at TEXT NOT NULL,
    last_reported_at TEXT,
    resolution TEXT,
    expires_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (responsibility_id, source_key)
  );
  CREATE INDEX items_by_state ON items (state, responsibility_id);

  ALTER TABLE runs ADD COLUMN responsibility_id TEXT REFERENCES responsibilities (id);
  ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE messages ADD COLUMN ref_id TEXT;
  `,

  // v4: assignments, for questions to colleagues and delegated tasks (Milestone 3).
  `
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'task')),
    requester_id TEXT NOT NULL REFERENCES agents (id),
    owner_id TEXT NOT NULL REFERENCES agents (id),
    parent_id TEXT REFERENCES assignments (id),
    conversation_id TEXT REFERENCES conversations (id),
    responsibility_id TEXT REFERENCES responsibilities (id),
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'waiting', 'delivered', 'accepted', 'failed')),
    run_budget INTEGER NOT NULL,
    runs_used INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    review TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX assignments_by_parent ON assignments (parent_id);
  CREATE INDEX assignments_by_status ON assignments (status, updated_at);

  ALTER TABLE runs ADD COLUMN assignment_id TEXT REFERENCES assignments (id);
  `,

  // v5: readers that staff write for folders no built-in reader covers (Milestone 4).
  `
  CREATE TABLE readers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    format TEXT NOT NULL,
    pattern TEXT NOT NULL,
    samples TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('drafting', 'proposed', 'approved', 'failed')),
    code TEXT,
    code_hash TEXT,
    approved_hash TEXT,
    notes TEXT,
    author_id TEXT REFERENCES agents (id),
    author_name TEXT,
    requester_id TEXT NOT NULL REFERENCES agents (id),
    assignment_id TEXT REFERENCES assignments (id),
    approved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,

  // v6: a briefing can wait for Codex, and records when it tries again (Milestone 5).
  `
  CREATE TABLE occurrences_v6 (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines (id),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'delivered', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_id TEXT REFERENCES runs (id),
    detail TEXT,
    retry_at TEXT,
    updated_at TEXT NOT NULL
  );
  INSERT INTO occurrences_v6 (id, routine_id, scheduled_for, status, attempts, run_id, detail, updated_at)
    SELECT id, routine_id, scheduled_for, status, attempts, run_id, detail, updated_at FROM occurrences;
  DROP TABLE occurrences;
  ALTER TABLE occurrences_v6 RENAME TO occurrences;
  CREATE INDEX occurrences_by_status ON occurrences (status);
  `,

  // v7: which chat messages were written from source data, and whether a chat's thread has taken
  // any in (Milestone 5). Threads in use that hold source data start out marked.
  `
  ALTER TABLE messages ADD COLUMN source_data INTEGER NOT NULL DEFAULT 0;
  UPDATE messages SET source_data = 1
    WHERE kind = 'briefing'
       OR run_id IN (SELECT id FROM runs WHERE kind IN ('follow_up', 'report', 'briefing'))
       OR agent_id IN (SELECT id FROM agents WHERE profile = 'data');
  ALTER TABLE conversations ADD COLUMN seen_message_id INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversations ADD COLUMN source_data INTEGER NOT NULL DEFAULT 0;
  UPDATE conversations SET seen_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE messages.conversation_id = conversations.id), 0);
  UPDATE conversations SET source_data = 1
    WHERE context_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id AND messages.source_data = 1);
  `,

  // v8: web search is a grant the operator gives a staff member, optionally limited to some sites.
  `
  CREATE TABLE web_grants (
    agent_id TEXT PRIMARY KEY REFERENCES agents (id),
    sites TEXT NOT NULL DEFAULT '[]',
    granted_at TEXT NOT NULL
  );
  `,

  // v9: the office policy, in versions. The operator writes one, or approves the Chief of Staff's.
  `
  CREATE TABLE policy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    author_id TEXT REFERENCES agents (id),
    reason TEXT,
    based_on INTEGER REFERENCES policy_versions (id),
    status TEXT NOT NULL,
    from_source_data INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  `,

  // v10: the model and reasoning level each staff member runs on, and what each run used.
  `
  ALTER TABLE agents ADD COLUMN model TEXT;
  ALTER TABLE agents ADD COLUMN effort TEXT;
  ALTER TABLE runs ADD COLUMN model TEXT;
  ALTER TABLE runs ADD COLUMN effort TEXT;
  `,

  // v11: views staff write in OpenUI Lang: under a chat reply, in a briefing section, or as a dashboard.
  `
  CREATE TABLE views (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('reply', 'section', 'dashboard')),
    agent_id TEXT NOT NULL REFERENCES agents (id),
    run_id TEXT REFERENCES runs (id),
    message_id INTEGER REFERENCES messages (id),
    title TEXT NOT NULL,
    program TEXT NOT NULL,
    outside TEXT NOT NULL CHECK (outside IN ('load', 'ask')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX views_by_message ON views (message_id);
  CREATE INDEX views_by_run ON views (run_id);
  `,

  // v12: whether an item needs the operator. Only those go in the Inbox; the rest are worth knowing.
  // Stories found on the web, keyed by their address, never need the operator.
  `
  ALTER TABLE items ADD COLUMN needs_operator INTEGER NOT NULL DEFAULT 1;
  UPDATE items SET needs_operator = 0 WHERE source_key LIKE 'http://%' OR source_key LIKE 'https://%';
  `,

  // v13: staff changes the Chief of Staff proposes from her review of the staff, or in chat.
  `
  CREATE TABLE staff_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents (id),
    agent_name TEXT NOT NULL,
    responsibility_id TEXT NOT NULL REFERENCES responsibilities (id),
    kind TEXT NOT NULL CHECK (kind IN ('instructions', 'model', 'end', 'replace')),
    detail TEXT NOT NULL,
    reason TEXT NOT NULL,
    proposed_by TEXT NOT NULL REFERENCES agents (id),
    run_id TEXT REFERENCES runs (id),
    from_source_data INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
    outcome TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX staff_changes_by_status ON staff_changes (status, agent_id);
  `,
];
