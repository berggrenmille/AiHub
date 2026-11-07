import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceConnection } from "@aihub/shared";
import { inProcess, type FieldValue, type FolderReader, type ReaderFile } from "./reader.ts";
import { BUILT_IN_READERS, isBuiltInReader } from "./readers.ts";
import { errorCode, matchesWords, messageOf, NoPathChosen, plural, type Identity, type SourceAdapter, type SourceContext, type SourceRecord } from "./source.ts";

// A folder of files as a source (DESIGN.md › Connectors and capabilities). The daemon walks the
// folder and reads the files; a reader turns each file's text into records. The daemon keys each
// record by its file and the reader's key, versions it by content, and diffs it against the cursor,
// so no reader decides what is new.

export const FOLDER_LIMITS = {
  files: 2_000,
  depth: 6,
  bytesPerFile: 2 * 1024 * 1024,
  bytesTotal: 50 * 1024 * 1024,
  /** Most changes one briefing hands a supervisor; the rest wait for the next check. */
  changesPerCheck: 60,
  /** Most records one read returns. */
  recordsPerRead: 100,
  /** Field values a read returns are cut to this length. */
  readValueLength: 1_000,
} as const;

/** The prefix of a reader staff wrote, as a connection names it: "staff:<id>". */
export const STAFF_READER_PREFIX = "staff:";

class FolderProblem extends Error {}

interface FolderRecord {
  key: string;
  ref: string;
  version: string;
  file: string;
  modified: number;
  title: string;
  fields: Record<string, FieldValue>;
}

interface Scan {
  files: number;
  records: FolderRecord[];
  errors: Array<{ file: string; error: string }>;
}

interface FolderCursor {
  records: Record<string, { version: string; title: string; file: string; fields: Record<string, string> }>;
}

export const folderSource: SourceAdapter = {
  kind: "folder",

  firstCheckNote:
    "This is your first look at this folder, so the changes are a sample of what it already holds, not news. Report only what needs the operator's attention under your responsibility, and keep a note of what you'll watch.",

  async verify(connection, context) {
    const scan = await scanFolder(connection, context);
    const reader = describeReader(connection);
    if (scan.files === 0) return `No ${connection.pattern ?? "matching"} files yet`;
    if (scan.records.length === 0 && scan.errors.length) throw new FolderProblem(`None of the files could be read: ${describeErrors(scan.errors)}`);
    const unreadable = scan.errors.length ? `. ${plural(scan.errors.length, "file")} couldn't be read: ${describeErrors(scan.errors)}` : "";
    return `${plural(scan.records.length, reader.noun, reader.nouns)} in ${plural(scan.files, "file")}${unreadable}`;
  },

  async changes(connection, previous, context) {
    const scan = await scanFolder(connection, context);
    if (scan.files > 0 && scan.records.length === 0 && scan.errors.length) {
      throw new FolderProblem(`None of the files could be read: ${describeErrors(scan.errors)}`);
    }
    const before = previous as FolderCursor | null;
    const current = new Map(scan.records.map((record) => [record.key, record]));
    type Change = { change: "new" | "changed" | "removed"; key: string; record: FolderRecord | null };
    const changes: Change[] = [];
    // Newest files first, so a cut keeps what was touched most recently.
    for (const record of [...scan.records].sort((a, b) => b.modified - a.modified || a.key.localeCompare(b.key))) {
      const was = before?.records[record.key];
      if (!was) changes.push({ change: "new", key: record.key, record });
      else if (was.version !== record.version) changes.push({ change: "changed", key: record.key, record });
    }
    for (const key of Object.keys(before?.records ?? {})) if (!current.has(key)) changes.push({ change: "removed", key, record: null });

    const firstCheck = before === null;
    const handed = changes.slice(0, FOLDER_LIMITS.changesPerCheck);
    const notes: string[] = [];
    // A first check records everything as seen and hands over a sample. Later checks hand over what
    // fits, and the cursor moves past only that, so the rest comes next time.
    const cursor: FolderCursor = { records: { ...before?.records } };
    for (const change of firstCheck ? changes : handed) {
      if (change.record) cursor.records[change.key] = cursorEntry(change.record);
      else delete cursor.records[change.key];
    }
    if (changes.length > handed.length) {
      notes.push(
        firstCheck
          ? `The folder holds ${scan.records.length} records; these are the ${handed.length} in the most recently changed files. AiHub records the rest as seen.`
          : `${changes.length - handed.length} more changes wait for your next check.`,
      );
    }
    if (scan.errors.length) notes.push(`${plural(scan.errors.length, "file")} couldn't be read: ${describeErrors(scan.errors)}`);

    const identities = new Map<string, Identity>();
    const records = handed.map((change): SourceRecord => {
      const was = before?.records[change.key];
      if (!change.record) {
        const ref = refOf(connection, change.key);
        identities.set(ref, { version: `removed:${was!.version}`, expiresAt: null });
        return { id: ref, change: "removed", title: was!.title, file: was!.file };
      }
      const { record } = change;
      identities.set(record.ref, { version: `${change.change}:${record.version}`, expiresAt: null });
      const changedFields = was ? changedFieldsOf(was.fields, record.fields) : null;
      return {
        id: record.ref,
        change: change.change,
        title: record.title,
        file: record.file,
        fields: record.fields,
        ...(changedFields && Object.keys(changedFields).length > 0 && { was: changedFields }),
      };
    });
    return { firstCheck, records, identities, cursor, notes };
  },

  async read(connection, query, context) {
    const scan = await scanFolder(connection, context);
    const matching = query.words.length
      ? scan.records.filter((record) => matchesWords([record.title, record.file, ...Object.values(record.fields).map(String)].join("\n"), query.words))
      : scan.records;
    const limit = Math.min(query.limit, FOLDER_LIMITS.recordsPerRead);
    const records = matching.slice(0, limit).map((record) => ({
      id: record.ref,
      title: record.title,
      file: record.file,
      fields: Object.fromEntries(Object.entries(record.fields).map(([name, value]) => [name, typeof value === "string" ? cut(value, FOLDER_LIMITS.readValueLength) : value])),
    }));
    const reader = describeReader(connection);
    const filtered = query.words.length ? ` match "${query.words.join(" ")}"` : "";
    const shown = records.length < matching.length ? ` Showing the first ${records.length}; narrow it with words to see others.` : "";
    const unreadable = scan.errors.length ? ` ${plural(scan.errors.length, "file")} couldn't be read: ${describeErrors(scan.errors)}` : "";
    return {
      summary: `${connection.label}: ${plural(matching.length, reader.noun, reader.nouns)}${filtered} out of ${scan.records.length} in ${plural(scan.files, "file")}.${shown} Long texts are cut at ${FOLDER_LIMITS.readValueLength} characters.${unreadable}`,
      data: { records },
    };
  },

  describeError(error) {
    if (error instanceof NoPathChosen) return "No folder has been chosen yet.";
    if (error instanceof FolderProblem) return error.message;
    const code = errorCode(error);
    if (code === "ENOENT") return "The folder isn't there any more. Pick its new location.";
    if (code === "ENOTDIR") return "That's a file, not a folder. Pick the folder that holds the files.";
    if (code === "EACCES" || code === "EPERM") return "AiHub can't read the folder. Check its permissions.";
    return `The folder couldn't be read: ${messageOf(error)}`;
  },
};

/** The reader a connection names, and what to call its records. */
function describeReader(connection: SourceConnection): { noun: string; nouns: string } {
  return isBuiltInReader(connection.reader) ? BUILT_IN_READERS[connection.reader] : { noun: "record", nouns: "records" };
}

function readerOf(connection: SourceConnection, context: SourceContext): FolderReader {
  if (isBuiltInReader(connection.reader)) return inProcess(BUILT_IN_READERS[connection.reader].reader);
  if (connection.reader?.startsWith(STAFF_READER_PREFIX)) {
    const reader = context.staffReader?.(connection.reader.slice(STAFF_READER_PREFIX.length));
    if (reader) return reader;
    throw new FolderProblem("The reader for this folder isn't approved, so AiHub won't run it.");
  }
  throw new FolderProblem(`AiHub has no reader called "${connection.reader ?? ""}".`);
}

/** The pattern's files in the folder and below, skipping hidden entries and links that could lead out. */
export function listFiles(root: string, pattern: string): Array<{ name: string; path: string; size: number; modified: number }> {
  if (!statSync(root).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  const matchers = pattern
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i"));
  const found: Array<{ name: string; path: string; size: number; modified: number }> = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < FOLDER_LIMITS.depth) walk(path, name, depth + 1);
      } else if (entry.isFile() && matchers.some((matcher) => matcher.test(entry.name))) {
        if (found.length >= FOLDER_LIMITS.files) throw new FolderProblem(`The folder has more than ${FOLDER_LIMITS.files} matching files. Pick a narrower folder.`);
        const stats = statSync(path);
        found.push({ name, path, size: stats.size, modified: stats.mtimeMs });
      }
    }
  };
  walk(root, "", 0);
  return found;
}

async function scanFolder(connection: SourceConnection, context: SourceContext): Promise<Scan> {
  if (!connection.path.trim()) throw new NoPathChosen();
  const reader = readerOf(connection, context);
  const listed = listFiles(connection.path, connection.pattern ?? "*");
  const errors: Scan["errors"] = [];
  const files: ReaderFile[] = [];
  const modified = new Map<string, number>();
  let total = 0;
  for (const file of listed) {
    if (file.size > FOLDER_LIMITS.bytesPerFile) {
      errors.push({ file: file.name, error: `it's ${Math.ceil(file.size / 1024 / 1024)} MB, and AiHub reads files up to 2 MB` });
      continue;
    }
    total += file.size;
    if (total > FOLDER_LIMITS.bytesTotal) throw new FolderProblem("The folder's files add up to more than 50 MB. Pick a narrower folder.");
    files.push({ name: file.name, text: readFileSync(file.path, "utf8") });
    modified.set(file.name, file.modified);
  }

  const reading = await reader(files);
  errors.push(...reading.errors);
  const records: FolderRecord[] = [];
  for (const { file, records: fileRecords } of reading.records) {
    const seen = new Map<string, number>();
    for (const record of fileRecords) {
      // The same key twice in a file, such as two identical rows, gets a counter so neither is lost.
      const base = record.key ? `${file}#${record.key}` : file;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const key = count === 1 ? base : `${base}~${count}`;
      records.push({
        key,
        ref: refOf(connection, key),
        version: hash(JSON.stringify([record.title, record.fields]), 16),
        file,
        modified: modified.get(file) ?? 0,
        title: record.title,
        fields: record.fields,
      });
    }
  }
  return { files: listed.length, records, errors };
}

/** The id the model sees: stable for a record in this connection, and opaque. */
function refOf(connection: SourceConnection, key: string): string {
  return `rec-${hash(`${connection.id}\n${key}`, 10)}`;
}

/** Short values as they are, so a change can say what a field was; long ones as a fingerprint. */
function cursorEntry(record: FolderRecord): FolderCursor["records"][string] {
  const fields = Object.fromEntries(
    Object.entries(record.fields).map(([name, value]) => {
      const text = value === null ? "" : String(value);
      return [name, text.length <= 80 ? text : `#${hash(text, 12)}`];
    }),
  );
  return { version: record.version, title: record.title, file: record.file, fields };
}

/** What each changed field was, or "(changed)" for long text. */
function changedFieldsOf(was: Record<string, string>, now: Record<string, FieldValue>): Record<string, string> | null {
  const changed: Record<string, string> = {};
  for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const before = was[name];
    const value = now[name];
    const text = value === null || value === undefined ? "" : String(value);
    const fingerprint = text.length <= 80 ? text : `#${hash(text, 12)}`;
    if (before === fingerprint) continue;
    if (before === undefined) changed[name] = "(not there)";
    else changed[name] = before.startsWith("#") ? "(changed)" : before;
  }
  return changed;
}

function describeErrors(errors: Array<{ file: string; error: string }>): string {
  const [first] = errors;
  if (!first) return "";
  return `${first.file}: ${first.error}${errors.length > 1 ? `, and ${errors.length - 1} more` : ""}`;
}

function hash(text: string, length: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
