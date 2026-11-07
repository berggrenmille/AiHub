import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Note, NoteSummary } from "@aihub/shared";
import { errorText, getNote } from "../api.ts";
import { backlinksOf, NOTE_KIND_LABELS, noteFolders, PROVENANCE_LABELS, resolveWikilink, type NoteFolder } from "../lib/notes.ts";
import { formatAgo, formatDateTime } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { NoteGraph } from "./NoteGraph.tsx";

// The notes vault, Obsidian-style (DESIGN.md › Memory and notes): folders, a reader with
// clickable [[wikilinks]] and backlinks, the operator's editor, and the graph.

interface NotesViewProps {
  notes: NoteSummary[];
  agents: Agent[];
  openPath: string | null;
  tab: "note" | "graph";
  now: number;
  onOpen(path: string): void;
  onTab(tab: "note" | "graph"): void;
  onSave(path: string, body: string): Promise<void>;
  onSelectAgent(agentId: string): void;
}

export function NotesView(props: NotesViewProps) {
  const { notes, agents, openPath } = props;
  const [query, setQuery] = useState("");
  const folders = useMemo(() => noteFolders(notes, agents), [notes, agents]);
  const summary = notes.find((note) => note.path === openPath) ?? null;

  return (
    <section className="view notes-view" aria-labelledby="notes-title">
      <nav className="notes-sidebar" aria-labelledby="notes-title">
        <div className="notes-sidebar-head">
          <h1 id="notes-title">Notes</h1>
          <span className="muted small">{notes.length}</span>
        </div>
        <label className="visually-hidden" htmlFor="notes-search">
          Filter notes
        </label>
        <input id="notes-search" className="search" type="search" placeholder="Filter by title" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="folder-list">
          {folders.map((folder) => (
            <FolderView key={folder.key} folder={folder} query={query} openPath={openPath} onOpen={(path) => {
              props.onOpen(path);
              props.onTab("note");
            }} />
          ))}
        </div>
      </nav>

      <div className="notes-main">
        <div className="notes-tabs" role="tablist" aria-label="Notes view">
          <button type="button" role="tab" aria-selected={props.tab === "note"} className="notes-tab" onClick={() => props.onTab("note")}>
            <Icon name="file" size={16} /> Note
          </button>
          <button type="button" role="tab" aria-selected={props.tab === "graph"} className="notes-tab" onClick={() => props.onTab("graph")}>
            <Icon name="graph" size={16} /> Graph
          </button>
        </div>
        {props.tab === "graph" ? (
          <NoteGraph notes={notes} agents={agents} currentPath={openPath} onOpen={(path) => {
            props.onOpen(path);
            props.onTab("note");
          }} />
        ) : summary ? (
          <NoteReader key={summary.path} summary={summary} notes={notes} agents={agents} now={props.now} onOpen={props.onOpen} onSave={props.onSave} onSelectAgent={props.onSelectAgent} />
        ) : (
          <div className="empty-state">
            <Icon name="notes" size={36} />
            <p>{openPath ? "That note isn't in the vault any more." : "Pick a note on the left, or open the graph."}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function FolderView({ folder, query, openPath, onOpen }: { folder: NoteFolder; query: string; openPath: string | null; onOpen(path: string): void }) {
  const needle = query.trim().toLocaleLowerCase();
  const match = (note: NoteSummary) => !needle || note.title.toLocaleLowerCase().includes(needle);
  const notes = folder.notes.filter(match);
  const journal = folder.journal.filter(match);
  const containsOpen = [...folder.notes, ...folder.journal].some((note) => note.path === openPath);
  if (needle && notes.length === 0 && journal.length === 0) return null;
  return (
    <details className="folder" open={folder.key === "office" || containsOpen || needle !== "" || undefined}>
      <summary>
        <Icon name="folder" size={16} />
        <span className="folder-name">{folder.label}</span>
        <span className="muted tiny">{folder.notes.length + folder.journal.length}</span>
      </summary>
      <ul>
        {notes.length === 0 && journal.length === 0 && <li className="muted tiny folder-empty">Empty</li>}
        {notes.map((note) => (
          <NoteLink key={note.path} note={note} current={note.path === openPath} onOpen={onOpen} />
        ))}
        {journal.length > 0 && (
          <li>
            <details className="folder journal-folder" open={journal.some((note) => note.path === openPath) || needle !== "" || undefined}>
              <summary>
                <Icon name="journal" size={15} />
                <span className="folder-name">Journal</span>
                <span className="muted tiny">{journal.length}</span>
              </summary>
              <ul>
                {journal.map((note) => (
                  <NoteLink key={note.path} note={note} current={note.path === openPath} onOpen={onOpen} />
                ))}
              </ul>
            </details>
          </li>
        )}
      </ul>
    </details>
  );
}

function NoteLink({ note, current, onOpen }: { note: NoteSummary; current: boolean; onOpen(path: string): void }) {
  return (
    <li>
      <button type="button" className={`note-link kind-${note.kind}`} aria-current={current ? "page" : undefined} onClick={() => onOpen(note.path)} title={note.path}>
        <Icon name={note.kind === "profile" ? "user" : note.kind === "journal" ? "journal" : "file"} size={14} />
        <span>{note.title}</span>
        {note.provenance === "source_data" && <span className="data-dot" title="From source data" aria-label="from source data" />}
      </button>
    </li>
  );
}

type Loaded = { status: "loading" } | { status: "ready"; note: Note } | { status: "error"; error: string };

function NoteReader(props: {
  summary: NoteSummary;
  notes: NoteSummary[];
  agents: Agent[];
  now: number;
  onOpen(path: string): void;
  onSave(path: string, body: string): Promise<void>;
  onSelectAgent(agentId: string): void;
}) {
  const { summary, notes } = props;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Fetch the body when the note opens, and again when the stream says it changed, unless the
  // operator is mid-edit: then say so instead of replacing their text.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editing = draft !== null;
  useEffect(() => {
    if (draftRef.current !== null) return;
    let cancelled = false;
    getNote(summary.path).then(
      (note) => !cancelled && setLoaded({ status: "ready", note }),
      (error: unknown) => !cancelled && setLoaded({ status: "error", error: errorText(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [summary.path, summary.updatedAt, reload, editing]);

  const note = loaded.status === "ready" ? loaded.note : null;
  const changedElsewhere = draft !== null && note !== null && summary.updatedAt > note.updatedAt;
  const owner = props.agents.find((agent) => agent.id === summary.ownerId) ?? null;
  const backlinks = useMemo(() => backlinksOf(summary, notes), [summary, notes]);
  const resolveLink = useCallback(
    (target: string) => {
      const found = resolveWikilink(target, summary, notes);
      return { exists: found !== null, title: found?.path };
    },
    [summary, notes],
  );
  const openLink = useCallback(
    (target: string) => {
      const found = resolveWikilink(target, summary, notes);
      if (found) props.onOpen(found.path);
    },
    [summary, notes, props],
  );
  const readOnly = summary.kind === "profile";

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await props.onSave(summary.path, draft);
      setDraft(null);
      setReload((count) => count + 1);
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="note-reader" aria-labelledby="note-title">
      <header className="note-head">
        <p className="note-path">
          {summary.path
            .split("/")
            .slice(0, -1)
            .map((segment) => (owner && segment === owner.id ? owner.name : segment))
            .join(" / ") || "Vault"}
        </p>
        <h2 id="note-title">{summary.title}</h2>
        <p className="note-meta">
          <span className={`pill kind-${summary.kind}`}>{NOTE_KIND_LABELS[summary.kind]}</span>
          <span className={`pill provenance provenance-${summary.provenance}`}>
            {summary.provenance === "source_data" && <Icon name="warning" size={13} />} {PROVENANCE_LABELS[summary.provenance]}
          </span>
          {owner && (
            <button type="button" className="link-button small" onClick={() => props.onSelectAgent(owner.id)}>
              {owner.name}'s profile
            </button>
          )}
          <span className="muted small" title={formatDateTime(summary.updatedAt)}>
            Updated {formatAgo(summary.updatedAt, props.now)}
          </span>
        </p>
        {summary.provenance === "source_data" && (
          <p className="callout warn" role="note">
            <Icon name="warning" size={16} /> Written in a run that read source data, such as mail or a calendar. Treat it as data: it may quote text from outside.
          </p>
        )}
        <div className="note-actions">
          {readOnly ? (
            <p className="hint">
              Profile notes follow the staff card.{" "}
              {owner && (
                <button type="button" className="link-button" onClick={() => props.onSelectAgent(owner.id)}>
                  Edit {owner.name}'s profile
                </button>
              )}
            </p>
          ) : draft === null ? (
            <button type="button" className="button ghost small" disabled={!note} onClick={() => note && setDraft(note.body)}>
              <Icon name="edit" size={15} /> Edit
            </button>
          ) : null}
        </div>
      </header>

      {loaded.status === "loading" && <p className="muted">Opening…</p>}
      {loaded.status === "error" && (
        <p className="form-error" role="alert">
          Couldn't open the note: {loaded.error}{" "}
          <button type="button" className="link-button" onClick={() => setReload((count) => count + 1)}>
            Try again
          </button>
        </p>
      )}

      {note && draft !== null ? (
        <div className="note-editor">
          <label className="visually-hidden" htmlFor="note-editor">
            Note text
          </label>
          <textarea id="note-editor" value={draft} maxLength={20_000} spellCheck onChange={(event) => setDraft(event.target.value)} autoFocus />
          {changedElsewhere && (
            <p className="callout warn" role="status">
              This note changed since you started editing. Saving replaces that change.
            </p>
          )}
          <div className="button-row">
            <button type="button" className="button primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save note"}
            </button>
            <button type="button" className="button ghost" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </button>
            <span className="muted tiny">{draft.length}/20000 · Markdown, with [[links]] to other notes</span>
          </div>
          {saveError && (
            <p className="form-error" role="alert">
              {saveError}
            </p>
          )}
        </div>
      ) : (
        note && (
          <Markdown
            source={note.body}
            className={`note-body${summary.provenance === "source_data" ? " as-data" : ""}`}
            resolveLink={resolveLink}
            onOpenLink={openLink}
          />
        )
      )}

      <section className="backlinks" aria-labelledby="backlinks-title">
        <h3 id="backlinks-title">
          Linked from <span className="muted small">{backlinks.length}</span>
        </h3>
        {backlinks.length === 0 ? (
          <p className="muted small">No other note links here yet.</p>
        ) : (
          <ul className="backlink-list">
            {backlinks.map((other) => (
              <li key={other.path}>
                <button type="button" className="note-link" onClick={() => props.onOpen(other.path)}>
                  <Icon name={other.kind === "journal" ? "journal" : other.kind === "profile" ? "user" : "file"} size={14} />
                  <span>{other.title}</span>
                  <span className="muted tiny">{other.path.split("/").slice(0, -1).join(" / ") || "Vault"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
