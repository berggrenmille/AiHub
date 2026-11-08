import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  ActivityEntry,
  Agent,
  Assignment,
  ModelChoice,
  ModelOption,
  NoteSummary,
  Responsibility,
  Routine,
  Run,
  SourceConnection,
  StaffReader,
  UpdateAgentRequest,
  WebGrant,
} from "@aihub/shared";
import { errorText } from "../api.ts";
import { assignmentsOf, teamWaitOf } from "../lib/assignments.ts";
import { lookFor } from "../lib/avatar.ts";
import { levelOf, XP_STEP } from "../lib/level.ts";
import { presenceOf, runsOf } from "../lib/presence.ts";
import { READER_STATUS_LABELS, readerName, readerOf } from "../lib/sources.ts";
import {
  activityTone,
  CONNECTION_STATUS_LABELS,
  formatAgo,
  formatDateTime,
  formatShortWhen,
  ROLE_LABELS,
  RUN_KIND_LABELS,
  triggerLabel,
} from "../format.ts";
import { AssignmentList } from "./Assignments.tsx";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";
import { StateBadge } from "./StateBadge.tsx";
import { ModelSetting } from "./ModelSetting.tsx";
import { modelName } from "../lib/models.ts";

// A staff member's profile card (DESIGN.md › The office experience): who they are, where they sit
// in the team, what they own, how far they've come, what they've done lately, and their notes.

interface ProfileCardProps {
  agent: Agent;
  agents: Agent[];
  responsibilities: Responsibility[];
  routines: Routine[];
  connections: SourceConnection[];
  runs: Record<string, Run>;
  activity: ActivityEntry[];
  assignments: Assignment[];
  notes: NoteSummary[];
  readers: StaffReader[];
  now: number;
  onClose(): void;
  onSelectAgent(agentId: string): void;
  /** Opens the chat with this staff member, starting one if needed. */
  onOpenChat(): Promise<void>;
  onOpenNote(path: string): void;
  onUpdate(changes: UpdateAgentRequest): Promise<void>;
  /** Gives web search, or with null takes it away. */
  onSetWeb(web: WebGrant | null): Promise<void>;
  /** The models Codex offers, or null until loaded. */
  models: ModelOption[] | null;
  onLoadModels(): Promise<unknown>;
  onSetModel(choice: ModelChoice): Promise<void>;
  onRunRoutine(routineId: string): Promise<void>;
  onSetWeekends(routineId: string, weekends: boolean): Promise<void>;
  /** For the Chief of Staff: her review of the staff, and asking for one now. */
  staffReview: { lastAt: string | null; running: boolean; onRun(): Promise<void> } | null;
}

export function ProfileCard(props: ProfileCardProps) {
  const { agent, agents, now } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false);
  const titleId = useId();

  // Open as a modal once. No close on cleanup: closing fires `close`, which would report the card
  // as dismissed; unmounting removes the dialog from the top layer anyway.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Another staff member's card opens in the same dialog: start at the top, out of edit mode.
  useEffect(() => {
    setEditing(false);
    dialogRef.current?.querySelector(".profile-scroll")?.scrollTo({ top: 0 });
  }, [agent.id]);

  const look = lookFor(agent.avatar);
  const level = levelOf(agent.experience);
  const manager = agents.find((candidate) => candidate.id === agent.managerId) ?? null;
  const team = agents.filter((candidate) => candidate.managerId === agent.id);
  const responsibility =
    props.responsibilities.find((candidate) => candidate.ownerId === agent.id && candidate.status === "active") ??
    props.responsibilities.find((candidate) => candidate.ownerId === agent.id) ??
    null;
  const routines = props.routines.filter((routine) => routine.ownerId === agent.id);
  const connections = props.connections.filter((connection) => agent.connectionIds.includes(connection.id));
  const runs = runsOf(agent.id, props.runs).slice(0, 6);
  const activity = props.activity.filter((entry) => entry.agentId === agent.id).slice(0, 8);
  const notes = props.notes.filter((note) => note.ownerId === agent.id);
  const presence = presenceOf(agent, props.runs, now);
  const assignments = assignmentsOf(agent.id, props.assignments);
  const teamWait = teamWaitOf(agent.id, props.assignments);
  // A toolsmith is whoever wrote a reader.
  const authored = props.readers.filter((reader) => reader.authorId === agent.id);

  return (
    <dialog
      ref={dialogRef}
      className="profile-dialog"
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current.close();
      }}
    >
      <div className="profile-card">
        <button type="button" className="icon-button profile-close" onClick={() => dialogRef.current?.close()} title="Close">
          <Icon name="close" />
          <span className="visually-hidden">Close the profile</span>
        </button>

        <aside className={`profile-hero presence-${presence}`}>
          <div className="hero-portrait" style={{ background: `radial-gradient(circle at 50% 40%, ${look.accent}55, transparent 70%)` }}>
            <Portrait look={look} size={168} label={`${agent.name}'s look`} />
          </div>
          <div className="level" title={`Level ${level.level + 1} at ${agent.experience + level.toNext} XP`}>
            <div className="level-head">
              <span className="level-badge">Lv {level.level}</span>
              <span className="level-rank">{level.rank}</span>
            </div>
            <div
              className="level-bar"
              role="progressbar"
              aria-label="Progress to the next level"
              aria-valuemin={0}
              aria-valuemax={level.span}
              aria-valuenow={level.into}
            >
              <span style={{ width: `${level.progress * 100}%` }} />
            </div>
            <p className="small muted">
              {agent.experience} XP · {level.toNext} to level {level.level + 1}
            </p>
            <p className="tiny muted">
              Experience counts delivered results and resolved items. Level L to L+1 takes {XP_STEP}×L.
            </p>
          </div>
          <ChatButton key={agent.id} name={agent.name} onOpen={props.onOpenChat} />
        </aside>

        <div className="profile-scroll">
          {editing ? (
            <ProfileEditor agent={agent} onCancel={() => setEditing(false)} onSave={async (changes) => {
              await props.onUpdate(changes);
              setEditing(false);
            }} titleId={titleId} />
          ) : (
            <header className="profile-head">
              <div>
                <h2 id={titleId}>{agent.name}</h2>
                <p className="profile-title">{agent.title || ROLE_LABELS[agent.role]}</p>
                <p className="profile-tags">
                  <span className={`pill role-${agent.role}`}>{ROLE_LABELS[agent.role]}</span>
                  <StateBadge state={presence} />
                  <span className="muted small">On staff since {formatDateTime(agent.hiredAt).slice(0, 10)}</span>
                </p>
              </div>
              <button type="button" className="button ghost small" onClick={() => setEditing(true)}>
                <Icon name="edit" size={16} /> Edit profile
              </button>
            </header>
          )}

          {!editing && (
            <section className="profile-section">
              <p className="lead">{agent.description || <span className="muted">No job description yet.</span>}</p>
              {agent.workingStyle && (
                <p className="working-style">
                  <span className="eyebrow">Working style</span> {agent.workingStyle}
                </p>
              )}
            </section>
          )}

          <section className="profile-section" aria-label="Team">
            <h3>Team</h3>
            <div className="team-grid">
              <div>
                <p className="eyebrow">Reports to</p>
                {manager ? <PersonChip agent={manager} onSelect={props.onSelectAgent} /> : <p className="muted">You, the operator</p>}
              </div>
              <div>
                <p className="eyebrow">Team</p>
                {team.length ? (
                  <div className="chip-row">
                    {team.map((member) => (
                      <PersonChip key={member.id} agent={member} onSelect={props.onSelectAgent} />
                    ))}
                  </div>
                ) : (
                  <p className="muted">{agent.role === "worker" ? "Workers recruit nobody." : "Nobody yet"}</p>
                )}
              </div>
            </div>
          </section>

          <section className="profile-section" aria-label="Responsibility">
            <h3>Responsibility</h3>
            {responsibility ? (
              <div className={`responsibility status-${responsibility.status}`}>
                <p>
                  <strong>{responsibility.title}</strong>{" "}
                  {responsibility.status === "ended" ? (
                    <span className="pill">Ended{responsibility.endedAt ? ` ${formatShortWhen(responsibility.endedAt)}` : ""}</span>
                  ) : responsibility.expiresAt ? (
                    <span className="pill tone-waiting">Mandate until {formatDateTime(responsibility.expiresAt)}</span>
                  ) : (
                    <span className="pill tone-done">Ongoing</span>
                  )}
                </p>
                {responsibility.scope && <p>{responsibility.scope}</p>}
                {responsibility.standingInstructions && (
                  <p className="instructions">
                    <span className="eyebrow">Standing instructions</span> {responsibility.standingInstructions}
                  </p>
                )}
              </div>
            ) : (
              <p className="muted">{agent.role === "chief_of_staff" ? "The morning briefing and any mandates you grant." : "None yet."}</p>
            )}
            {routines.length > 0 && <RoutineList routines={routines} onRun={props.onRunRoutine} onSetWeekends={props.onSetWeekends} now={now} />}
            {props.staffReview && <StaffReviewRow {...props.staffReview} now={now} />}
          </section>

          <section className="profile-section" aria-labelledby={`${titleId}-assignments`}>
            <h3 id={`${titleId}-assignments`}>Assignments</h3>
            {teamWait && (
              <p className="callout wait">
                <Icon name="hourglass" size={16} /> Waiting on the team for “{teamWait.task.title}”
                {teamWait.total > 0 && `: ${teamWait.settled} of ${teamWait.total} in`}.
              </p>
            )}
            {assignments.length === 0 ? (
              <p className="muted">
                {agent.role === "worker" ? "No assignment on record." : `Nothing asked of ${agent.name}, and nothing ${agent.name} asked for, yet.`}
              </p>
            ) : (
              <AssignmentList key={agent.id} assignments={assignments} agents={agents} agentId={agent.id} now={now} onSelectAgent={props.onSelectAgent} />
            )}
          </section>

          <section className="profile-section" aria-label="Connections">
            <h3>Connections</h3>
            {connections.length === 0 ? (
              <p className="muted">{agent.web ? `${agent.name} reads no sources on this PC.` : `${agent.name} reads no sources.`}</p>
            ) : (
              <>
                {agent.state === "waiting_for_access" && (
                  <p className="callout warn">
                    <Icon name="lock" size={16} /> {agent.name} is waiting for access: a connection it needs isn't working yet.
                  </p>
                )}
                <ul className="connection-list">
                  {connections.map((connection) => (
                    <li key={connection.id}>
                      <span className={`dot status-${connection.status}`} aria-hidden="true" />
                      <span>
                        <strong>{connection.label}</strong>
                        {connection.detail && <span className="muted small block">{connection.detail}</span>}
                        <ConnectionFacts connection={connection} readers={props.readers} />
                      </span>
                      <span className={`pill status-${connection.status}`}>{CONNECTION_STATUS_LABELS[connection.status]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <WebAccess key={agent.id} agent={agent} onSet={props.onSetWeb} />
          </section>

          <section className="profile-section" aria-label="Model">
            <h3>Model</h3>
            <ModelSetting
              key={agent.id}
              agent={agent}
              models={props.models}
              lastRun={runsOf(agent.id, props.runs).find((run) => run.model !== null) ?? null}
              now={now}
              onLoad={props.onLoadModels}
              onSet={props.onSetModel}
            />
          </section>

          {authored.length > 0 && (
            <section className="profile-section" aria-label={authored.length === 1 ? "Reader" : "Readers"}>
              <h3>{authored.length === 1 ? "Reader" : "Readers"}</h3>
              <ul className="reader-list">
                {authored.map((reader) => (
                  <li key={reader.id}>
                    <ReaderSummary reader={reader} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="profile-section" aria-label="Recent runs">
            <h3>Recent runs</h3>
            {runs.length === 0 ? (
              <p className="muted">No runs yet.</p>
            ) : (
              <ul className="run-list">
                {runs.map((run) => (
                  <li key={run.id}>
                    <StateBadge state={run.state} />
                    <span className="run-title">
                      {run.title}
                      {run.error && <span className="block small tone-text-failed">{run.error}</span>}
                    </span>
                    <span className="muted small" title={formatDateTime(run.startedAt ?? run.queuedAt)}>
                      {RUN_KIND_LABELS[run.kind]} · {run.turns} turn{run.turns === 1 ? "" : "s"}
                      {run.model && ` · ${modelName(run.model, props.models)}${run.effort ? `, ${run.effort}` : ""}`} ·{" "}
                      {formatAgo(run.finishedAt ?? run.startedAt ?? run.queuedAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="profile-section" aria-label="Recent activity">
            <h3>Recent activity</h3>
            {activity.length === 0 ? (
              <p className="muted">Nothing yet.</p>
            ) : (
              <ol className="mini-feed">
                {activity.map((entry) => (
                  <li key={entry.id} className={`tone-${activityTone(entry.kind)}`}>
                    <span className="feed-marker" aria-hidden="true" />
                    <span>{entry.summary}</span>
                    <time className="muted small" dateTime={entry.at} title={formatDateTime(entry.at)}>
                      {formatAgo(entry.at, now)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="profile-section" aria-label="Notes">
            <h3>Notes</h3>
            {notes.length === 0 ? (
              <p className="muted">No notes yet.</p>
            ) : (
              <ul className="note-chips">
                {[...notes]
                  .sort((a, b) => (a.kind === "journal" ? 1 : 0) - (b.kind === "journal" ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt))
                  .slice(0, 10)
                  .map((note) => (
                    <li key={note.path}>
                      <button type="button" className={`note-chip kind-${note.kind} provenance-${note.provenance}`} onClick={() => props.onOpenNote(note.path)}>
                        <Icon name={note.kind === "journal" ? "journal" : note.kind === "profile" ? "user" : "file"} size={15} />
                        {note.title}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}

/** Opens the chat with this staff member. The first time, the daemon starts it. */
function ChatButton({ name, onOpen }: { name: string; onOpen(): Promise<void> }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      await onOpen();
    } catch (failure) {
      setError(`Couldn't open the chat: ${errorText(failure)}`);
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="chat-open">
      <button type="button" className="button primary wide" disabled={opening} onClick={() => void open()}>
        <Icon name="chat" /> {opening ? "Opening the chat…" : `Chat with ${name}`}
      </button>
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Web search, which the operator gives and takes away here (DESIGN.md › Authority and data
 * boundaries). It searches OpenAI's index and opens no live pages, so no site sees what is looked up.
 */
function WebAccess({ agent, onSet }: { agent: Agent; onSet(web: WebGrant | null): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [sites, setSites] = useState(agent.web?.sites.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const save = async (web: WebGrant | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSet(web);
      setEditing(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save({ sites: sites.split(/[\s,]+/).filter(Boolean) });
  };
  const failure = error && (
    <p className="form-error small" role="alert">
      {error}
    </p>
  );

  if (editing) {
    return (
      <form className="web-access" onSubmit={submit}>
        <div className="field">
          <label htmlFor={`${id}-sites`}>
            Web search for {agent.name} <span className="muted tiny">optional: only these sites</span>
          </label>
          <input
            id={`${id}-sites`}
            type="text"
            placeholder="Any site, or such as reuters.com, bbc.com"
            value={sites}
            onChange={(event) => setSites(event.target.value)}
          />
        </div>
        <p className="tiny muted">
          Search answers from OpenAI's index and opens no live pages, so no site sees what {agent.name} looks up. What it finds is treated as untrusted, and every
          search shows in the activity log.
        </p>
        <div className="button-row">
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? "Saving…" : agent.web ? "Save sites" : "Give web search"}
          </button>
          <button type="button" className="button ghost" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        {failure}
      </form>
    );
  }
  if (!agent.web) {
    return (
      <div className="web-access">
        <button type="button" className="button ghost" onClick={() => setEditing(true)}>
          <Icon name="globe" size={16} /> Give web search
        </button>
        {failure}
      </div>
    );
  }
  return (
    <div className="web-access">
      <ul className="connection-list">
        <li>
          <span className="dot status-connected" aria-hidden="true" />
          <span>
            <strong>Web search</strong>
            <span className="muted small block">{agent.web.sites.length ? `Only ${agent.web.sites.join(", ")}` : "Any site"}. Searches an index, opens no live pages.</span>
          </span>
          <span className="button-row">
            <button type="button" className="button ghost small" disabled={saving} onClick={() => setEditing(true)}>
              Sites
            </button>
            <button type="button" className="button ghost small" disabled={saving} onClick={() => void save(null)}>
              {saving ? "Turning off…" : "Turn off"}
            </button>
          </span>
        </li>
      </ul>
      {failure}
    </div>
  );
}

/** Where a source is: a calendar's file, or a folder with the files it reads and the reader for them. */
function ConnectionFacts({ connection, readers }: { connection: SourceConnection; readers: StaffReader[] }) {
  if (connection.kind !== "folder") {
    return (
      <dl className="connection-facts">
        <div>
          <dt>File</dt>
          <dd className="connection-path">{connection.path || "Not chosen yet"}</dd>
        </div>
      </dl>
    );
  }
  const info = readerOf(connection.reader, readers);
  const staff = info?.kind === "staff" ? info.reader : null;
  return (
    <dl className="connection-facts">
      <div>
        <dt>Folder</dt>
        <dd className="connection-path">{connection.path || "Not chosen yet"}</dd>
      </div>
      <div>
        <dt>Files</dt>
        <dd>{connection.pattern || "*"}</dd>
      </div>
      <div>
        <dt>Reader</dt>
        <dd>
          {readerName(info)}
          {staff?.authorName && <span className="muted">, by {staff.authorName}</span>}{" "}
          {staff && <span className={`pill reader-status status-${staff.status}`}>{READER_STATUS_LABELS[staff.status]}</span>}
        </dd>
      </div>
    </dl>
  );
}

/** A reader this staff member wrote: how far along it is, their notes, and the code. */
function ReaderSummary({ reader }: { reader: StaffReader }) {
  return (
    <div className="reader-box">
      <p className="reader-head">
        <strong>{reader.name}</strong>
        <span className={`pill reader-status status-${reader.status}`}>{READER_STATUS_LABELS[reader.status]}</span>
      </p>
      <p className="small muted">
        For {reader.pattern} files{reader.sampleNames.length > 0 ? `, written from ${reader.sampleNames.join(", ")}` : ""}.
      </p>
      {reader.notes && (
        <p className="reader-notes small">
          <span className="eyebrow">Notes</span> {reader.notes}
        </p>
      )}
      {reader.code ? (
        <details className="reader-code">
          <summary>The reader's code</summary>
          <pre>
            <code>{reader.code}</code>
          </pre>
        </details>
      ) : (
        <p className="muted small">{reader.status === "failed" ? "No code was handed in." : "No code handed in yet."}</p>
      )}
    </div>
  );
}

function PersonChip({ agent, onSelect }: { agent: Agent; onSelect(agentId: string): void }) {
  return (
    <button type="button" className="person-chip" onClick={() => onSelect(agent.id)}>
      <Portrait look={lookFor(agent.avatar)} size={28} animated={false} />
      <span>
        <strong>{agent.name}</strong>
        <span className="muted small block">{agent.title || ROLE_LABELS[agent.role]}</span>
      </span>
    </button>
  );
}

function RoutineList({
  routines,
  onRun,
  onSetWeekends,
  now,
}: {
  routines: Routine[];
  onRun(routineId: string): Promise<void>;
  onSetWeekends(routineId: string, weekends: boolean): Promise<void>;
  now: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const id = useId();
  const [message, setMessage] = useState<{ routineId: string; text: string; error: boolean } | null>(null);
  const run = async (routine: Routine) => {
    setBusy(routine.id);
    setMessage(null);
    try {
      await onRun(routine.id);
      setMessage({ routineId: routine.id, text: "Started. Watch the office.", error: false });
    } catch (failure) {
      setMessage({ routineId: routine.id, text: errorText(failure), error: true });
    } finally {
      setBusy(null);
    }
  };
  const setWeekends = async (routine: Routine, weekends: boolean) => {
    setBusy(routine.id);
    setMessage(null);
    try {
      await onSetWeekends(routine.id, weekends);
    } catch (failure) {
      setMessage({ routineId: routine.id, text: errorText(failure), error: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="routine-list">
      {routines.map((routine) => (
        <li key={routine.id}>
          <div>
            <strong>{routine.title}</strong>
            <span className="muted small block">
              {triggerLabel(routine.trigger)} · {routine.dailyTurnBudget} turns a day
              {routine.paused ? " · paused" : routine.nextRunAt ? ` · next ${formatShortWhen(routine.nextRunAt, new Date(now))}` : ""}
            </span>
            {routine.trigger.type !== "briefing" && (
              <label className="toggle routine-weekends" htmlFor={`${id}-${routine.id}-weekends`}>
                <input
                  id={`${id}-${routine.id}-weekends`}
                  type="checkbox"
                  checked={routine.trigger.type === "daily"}
                  disabled={busy !== null}
                  onChange={(event) => void setWeekends(routine, event.target.checked)}
                />
                Weekends too
              </label>
            )}
            {message?.routineId === routine.id && (
              <span className={`small block ${message.error ? "form-error" : "tone-text-done"}`} role={message.error ? "alert" : "status"}>
                {message.text}
              </span>
            )}
          </div>
          <button type="button" className="button ghost small" disabled={busy !== null || routine.paused} onClick={() => void run(routine)}>
            <Icon name="play" size={14} /> {busy === routine.id ? "Starting…" : "Run now"}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The Chief of Staff's review of the staff (DESIGN.md › Staff review): when it runs, and a review on request. */
function StaffReviewRow({ lastAt, running, onRun, now }: { lastAt: string | null; running: boolean; onRun(): Promise<void>; now: number }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await onRun();
      setMessage({ text: "Started. Her suggestions, if any, arrive in her chat.", error: false });
    } catch (failure) {
      setMessage({ text: errorText(failure), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ul className="routine-list">
      <li>
        <div>
          <strong>Staff review</strong>
          <span className="muted small block">
            When a warning sign shows after a briefing, and a week later if it stands · {running ? "reviewing now" : lastAt ? `last ${formatShortWhen(lastAt, new Date(now))}` : "not yet"}
          </span>
          {message && (
            <span className={`small block ${message.error ? "form-error" : "tone-text-done"}`} role={message.error ? "alert" : "status"}>
              {message.text}
            </span>
          )}
        </div>
        <button type="button" className="button ghost small" disabled={busy || running} onClick={() => void run()}>
          <Icon name="team" size={14} /> {busy ? "Starting…" : "Review now"}
        </button>
      </li>
    </ul>
  );
}

const LIMITS = { name: 40, title: 60, description: 400, workingStyle: 200 } as const;

function ProfileEditor({ agent, onSave, onCancel, titleId }: { agent: Agent; onSave(changes: UpdateAgentRequest): Promise<void>; onCancel(): void; titleId: string }) {
  const [form, setForm] = useState({ name: agent.name, title: agent.title, description: agent.description, workingStyle: agent.workingStyle });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const changes: UpdateAgentRequest = {};
    for (const key of ["name", "title", "description", "workingStyle"] as const) {
      const value = form[key].trim();
      if (value !== agent[key]) changes[key] = value;
    }
    if (changes.name === "") {
      setError("A name is required.");
      return;
    }
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(changes);
    } catch (failure) {
      setError(errorText(failure));
      setSaving(false);
    }
  };

  const field = (key: keyof typeof LIMITS, label: string, multiline = false) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>
        {label} <span className="muted tiny">{form[key].length}/{LIMITS[key]}</span>
      </label>
      {multiline ? (
        <textarea id={`${id}-${key}`} rows={key === "description" ? 3 : 2} maxLength={LIMITS[key]} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
      ) : (
        <input id={`${id}-${key}`} type="text" maxLength={LIMITS[key]} value={form[key]} required={key === "name"} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
      )}
    </div>
  );

  return (
    <form className="profile-editor" onSubmit={(event) => void submit(event)}>
      <h2 id={titleId}>Edit {agent.name}</h2>
      {field("name", "Name")}
      {field("title", "Title")}
      {field("description", "Job description", true)}
      {field("workingStyle", "Working style", true)}
      <p className="tiny muted">The profile note in the vault follows these changes.</p>
      <div className="button-row">
        <button type="submit" className="button primary" disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
        <button type="button" className="button ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
