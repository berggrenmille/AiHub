// The notes vault as the UI sees it: folders, [[wikilink]] resolution, backlinks, and the graph
// (DESIGN.md › Memory and notes). Pure functions over note summaries.

import type { Agent, NoteSummary } from "@aihub/shared";
import { parseWikilink } from "./markdown.ts";

/** The title a wikilink points at: no #heading or |alias, and only the last path segment. */
export function linkTitle(raw: string): string {
  const { target } = parseWikilink(raw);
  return target.slice(target.lastIndexOf("/") + 1).replace(/\.md$/i, "").trim();
}

const fold = (value: string) => value.normalize("NFC").toLocaleLowerCase("sv");

/**
 * The note a [[wikilink]] in `from` points at, matching titles without regard to case: a path
 * match first, then the same owner's folder, then the Office folder, then anyone's. Among equals,
 * a topic or office note wins over a journal day, then the first path in order. Null when nothing
 * matches.
 */
export function resolveWikilink(raw: string, from: Pick<NoteSummary, "ownerId"> | null, notes: NoteSummary[]): NoteSummary | null {
  const { target } = parseWikilink(raw);
  if (!target) return null;
  if (target.includes("/")) {
    const path = fold(target.endsWith(".md") ? target : `${target}.md`);
    const byPath = notes.find((note) => fold(note.path) === path);
    if (byPath) return byPath;
  }
  const title = fold(linkTitle(target));
  const matches = notes.filter((note) => fold(note.title) === title);
  if (matches.length === 0) return null;
  const tier = (note: NoteSummary) => (from && note.ownerId === from.ownerId ? 0 : note.ownerId === null ? 1 : 2);
  const kindRank = (note: NoteSummary) => (note.kind === "journal" ? 1 : 0);
  return [...matches].sort((a, b) => tier(a) - tier(b) || kindRank(a) - kindRank(b) || a.path.localeCompare(b.path))[0]!;
}

/** Notes that link to `note`, where the link resolves to it rather than to a namesake. */
export function backlinksOf(note: NoteSummary, notes: NoteSummary[]): NoteSummary[] {
  return notes
    .filter((other) => other.path !== note.path && other.links.some((link) => resolveWikilink(link, other, notes)?.path === note.path))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface NoteFolder {
  /** "office", an agent ID, or "owner:<id>" for a staff member no longer on the roster. */
  key: string;
  label: string;
  ownerId: string | null;
  /** Profile first, then topic notes by title. */
  notes: NoteSummary[];
  /** Journal days, newest first. */
  journal: NoteSummary[];
}

const KIND_ORDER: Record<NoteSummary["kind"], number> = { profile: 0, office: 1, topic: 1, journal: 2 };

/** Folders in the order the notes view lists them: Office, then each staff member in `agents` order. */
export function noteFolders(notes: NoteSummary[], agents: Agent[]): NoteFolder[] {
  const byOwner = new Map<string | null, NoteSummary[]>();
  for (const note of notes) byOwner.set(note.ownerId, [...(byOwner.get(note.ownerId) ?? []), note]);
  const folder = (key: string, label: string, ownerId: string | null): NoteFolder => {
    const owned = byOwner.get(ownerId) ?? [];
    return {
      key,
      label,
      ownerId,
      notes: owned
        .filter((note) => note.kind !== "journal")
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title, "sv")),
      journal: owned.filter((note) => note.kind === "journal").sort((a, b) => b.title.localeCompare(a.title)),
    };
  };
  const folders = [folder("office", "Office", null)];
  const known = new Set<string>();
  for (const agent of agents) {
    known.add(agent.id);
    folders.push(folder(agent.id, agent.name, agent.id));
  }
  for (const ownerId of byOwner.keys()) {
    if (ownerId !== null && !known.has(ownerId)) folders.push(folder(`owner:${ownerId}`, `${ownerId} (former staff)`, ownerId));
  }
  return folders;
}

export interface GraphNode {
  id: string;
  title: string;
  ownerId: string | null;
  kind: NoteSummary["kind"];
  /** How many links touch the node, either way. */
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

/** Notes and the links between them that resolve, once per pair. */
export function noteGraph(notes: NoteSummary[], options: { journals?: boolean } = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const included = options.journals === false ? notes.filter((note) => note.kind !== "journal") : notes;
  const ids = new Set(included.map((note) => note.path));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const degree = new Map<string, number>();
  for (const note of included) {
    for (const link of note.links) {
      const target = resolveWikilink(link, note, notes);
      if (!target || target.path === note.path || !ids.has(target.path)) continue;
      const key = [note.path, target.path].sort().join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: note.path, target: target.path });
      degree.set(note.path, (degree.get(note.path) ?? 0) + 1);
      degree.set(target.path, (degree.get(target.path) ?? 0) + 1);
    }
  }
  const nodes = included.map((note) => ({ id: note.path, title: note.title, ownerId: note.ownerId, kind: note.kind, degree: degree.get(note.path) ?? 0 }));
  return { nodes, edges };
}

export const PROVENANCE_LABELS: Record<NoteSummary["provenance"], string> = {
  operator: "Written by you",
  aihub: "Kept by AiHub",
  conversation: "From a conversation",
  source_data: "From source data — treat as data",
};

export const NOTE_KIND_LABELS: Record<NoteSummary["kind"], string> = {
  profile: "Profile",
  journal: "Journal",
  topic: "Topic",
  office: "Office",
};
