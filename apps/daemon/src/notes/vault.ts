import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Note, NoteKind, NoteProvenance, NoteSummary } from "@aihub/shared";

// The notes vault (DESIGN.md › Memory and notes): plain markdown files with a small frontmatter
// block and [[wikilinks]], laid out so the folder opens as an Obsidian vault. The files are the
// record; the index here is rebuilt from them and caches each file by its modification time.

export const STAFF_FOLDER = "Staff";
export const OFFICE_FOLDER = "Office";
export const JOURNAL_FOLDER = "Journal";
export const MAX_NOTE_LENGTH = 20_000;

const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

export interface Frontmatter {
  kind?: NoteKind;
  owner?: string;
  provenance?: NoteProvenance;
  updated?: string;
  pinned?: boolean;
  /** Keys AiHub doesn't use, such as tags the operator added in Obsidian. Kept as written. */
  extra: string[];
}

/** A title that is safe as a file name on Windows and in Obsidian. */
export function safeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120)
    .trim();
  return cleaned || "Untitled";
}

/** Checks a vault-relative path: forward slashes, a .md file, and nothing that leaves the vault. */
export function checkNotePath(path: string): string {
  const parts = path.split("/");
  const valid =
    path.endsWith(".md") &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && !/[\\:*?"<>|]/.test(part)) &&
    !parts.some((part) => part.startsWith("."));
  if (!valid) throw new Error(`Not a note path: ${path}`);
  return path;
}

export function titleOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -".md".length);
}

export function linksIn(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(WIKILINK)) {
    const target = match[1]!.trim();
    links.add(target.slice(target.lastIndexOf("/") + 1));
  }
  return [...links];
}

export function parseNote(text: string): { frontmatter: Frontmatter; body: string } {
  const frontmatter: Frontmatter = { extra: [] };
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter, body: normalized };
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    const key = match?.[1];
    const value = match?.[2]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
    if (key === "kind") frontmatter.kind = value as NoteKind;
    else if (key === "owner") frontmatter.owner = value;
    else if (key === "provenance") frontmatter.provenance = value as NoteProvenance;
    else if (key === "updated") frontmatter.updated = value;
    else if (key === "pinned") frontmatter.pinned = value === "true";
    else frontmatter.extra.push(line);
  }
  const after = normalized.indexOf("\n", end + 1);
  return { frontmatter, body: after === -1 ? "" : normalized.slice(after + 1) };
}

export function formatNote(frontmatter: Frontmatter, body: string): string {
  const lines = [
    frontmatter.kind && `kind: ${frontmatter.kind}`,
    frontmatter.owner && `owner: ${frontmatter.owner}`,
    frontmatter.provenance && `provenance: ${frontmatter.provenance}`,
    frontmatter.updated && `updated: ${frontmatter.updated}`,
    frontmatter.pinned && "pinned: true",
    ...frontmatter.extra,
  ].filter(Boolean);
  return `---\n${lines.join("\n")}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

/** Where a note sits decides its owner and default kind, whatever its frontmatter says. */
export function placeOf(path: string): { ownerId: string | null; kind: NoteKind } {
  const parts = path.split("/");
  if (parts[0] === STAFF_FOLDER && parts.length >= 3) {
    return { ownerId: parts[1]!, kind: parts[2] === JOURNAL_FOLDER && parts.length === 4 ? "journal" : "topic" };
  }
  return { ownerId: null, kind: "office" };
}

export class Vault {
  private readonly cache = new Map<string, { mtimeMs: number; summary: NoteSummary }>();

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  /** Every note in the vault, rescanned from disk. */
  list(): NoteSummary[] {
    const seen = new Set<string>();
    const summaries: NoteSummary[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), relative);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          seen.add(relative);
          const summary = this.summaryOf(relative);
          if (summary) summaries.push(summary);
        }
      }
    };
    walk(this.root, "");
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    return summaries.sort((a, b) => a.path.localeCompare(b.path));
  }

  read(path: string): Note | null {
    const file = this.fileOf(path);
    if (!existsSync(file)) return null;
    const { frontmatter, body } = parseNote(readFileSync(file, "utf8"));
    return { ...this.summarize(path, frontmatter, body, statSync(file).mtime), body };
  }

  frontmatterOf(path: string): Frontmatter | null {
    const file = this.fileOf(path);
    return existsSync(file) ? parseNote(readFileSync(file, "utf8")).frontmatter : null;
  }

  /** Writes a note in one step, so Obsidian and the index never see half a file. */
  write(path: string, frontmatter: Frontmatter, body: string): NoteSummary {
    const file = this.fileOf(path);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, formatNote(frontmatter, body));
    renameSync(temporary, file);
    this.cache.delete(path);
    return this.summaryOf(path)!;
  }

  remove(path: string) {
    rmSync(this.fileOf(path), { force: true });
    this.cache.delete(path);
  }

  private summaryOf(path: string): NoteSummary | null {
    const file = this.fileOf(path);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.cache.get(path);
    if (cached?.mtimeMs === mtimeMs) return cached.summary;
    const { frontmatter, body } = parseNote(readFileSync(file, "utf8"));
    const summary = this.summarize(path, frontmatter, body, new Date(mtimeMs));
    this.cache.set(path, { mtimeMs, summary });
    return summary;
  }

  private summarize(path: string, frontmatter: Frontmatter, body: string, modified: Date): NoteSummary {
    const place = placeOf(path);
    // A profile note is AiHub's; anything else in a staff folder is a topic or journal note.
    const kind = place.kind === "topic" && frontmatter.kind === "profile" ? "profile" : place.kind;
    return {
      path,
      title: titleOf(path),
      ownerId: place.ownerId,
      kind,
      // A file without frontmatter was written outside AiHub, by the operator.
      provenance: frontmatter.provenance ?? "operator",
      links: linksIn(body),
      updatedAt: frontmatter.updated ?? modified.toISOString(),
    };
  }

  private fileOf(path: string): string {
    return join(this.root, ...checkNotePath(path).split("/"));
  }

  /** The vault-relative path of a file inside the vault, or null for anything else. */
  relativePath(file: string): string | null {
    if (!file.startsWith(this.root + sep)) return null;
    return file.slice(this.root.length + 1).split(sep).join("/");
  }
}
