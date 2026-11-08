// Sources as the operator sees them (DESIGN.md › Connectors and capabilities): which files a folder
// reads and with what reader, how far a reader staff wrote has come, what a preview found, and
// whether a proposal's source can be approved yet. Pure functions over records, so they can be
// tested on their own.

import type { BuiltInReader, ProposedSource, SourcePreview, StaffReader, StaffReaderStatus } from "@aihub/shared";

/** How a source names a reader a toolsmith wrote: "staff:<id>". */
export const STAFF_READER_PREFIX = "staff:";

/**
 * The built-in readers: the files each reads when the source names no pattern, as the daemon
 * defaults them, and what each makes of a file.
 */
export const BUILT_IN_READERS: Record<BuiltInReader, { label: string; files: string; pattern: string; records: string }> = {
  markdown: { label: "Markdown", files: "markdown notes", pattern: "*.md", records: "One record per note, with its frontmatter as fields." },
  text: { label: "Plain text", files: "text files", pattern: "*.txt", records: "One record per file, titled by its first line." },
  csv: { label: "CSV", files: "CSV files", pattern: "*.csv", records: "One record per row." },
  json: { label: "JSON", files: "JSON files", pattern: "*.json", records: "One record per object." },
};

/** A staff reader's status, in the operator's words. */
export const READER_STATUS_LABELS: Record<StaffReaderStatus, string> = {
  drafting: "Writing it",
  proposed: "Handed in, waiting for you",
  approved: "Approved",
  failed: "Never finished",
};

export function isBuiltInReader(name: string | null | undefined): name is BuiltInReader {
  return !!name && Object.hasOwn(BUILT_IN_READERS, name);
}

/** The id of the staff reader a source names, or null when it names a built-in one or none. */
export function staffReaderId(reader: string | null | undefined): string | null {
  return reader?.startsWith(STAFF_READER_PREFIX) ? reader.slice(STAFF_READER_PREFIX.length) || null : null;
}

export type ReaderInfo =
  | { kind: "built_in"; name: BuiltInReader; label: string; files: string; pattern: string; records: string }
  /** A reader a toolsmith wrote. Null when it isn't on file, such as one aged out of the snapshot. */
  | { kind: "staff"; id: string; reader: StaffReader | null }
  /** A name AiHub has no reader for. */
  | { kind: "unknown"; name: string };

/** The reader a folder source names, or null when it names none. */
export function readerOf(reader: string | null | undefined, readers: StaffReader[]): ReaderInfo | null {
  if (!reader) return null;
  if (isBuiltInReader(reader)) return { kind: "built_in", name: reader, ...BUILT_IN_READERS[reader] };
  const id = staffReaderId(reader);
  if (id) return { kind: "staff", id, reader: readers.find((candidate) => candidate.id === id) ?? null };
  return { kind: "unknown", name: reader };
}

/** The reader's name for a list of facts, such as "Markdown (built in)" or "Bank export". */
export function readerName(info: ReaderInfo | null): string {
  if (!info) return "None named";
  if (info.kind === "built_in") return `${info.label} (built in)`;
  if (info.kind === "staff") return info.reader?.name ?? "A reader staff wrote, no longer on file";
  return info.name;
}

/** The files a folder source reads: its own pattern, else the reader's, else every file. */
export function patternOf(source: { pattern?: string | null; reader?: string | null }, readers: StaffReader[]): string {
  const own = source.pattern?.trim();
  if (own) return own;
  const info = readerOf(source.reader, readers);
  if (info?.kind === "built_in") return info.pattern;
  if (info?.kind === "staff" && info.reader) return info.reader.pattern;
  return "*";
}

/**
 * The reader each toolsmith has in hand, by author: the newest one still being written or handed
 * in and waiting for the operator. The office shows them at work on it until the operator decides.
 * Expects readers newest first, as the state keeps them.
 */
export function readersInHand(readers: StaffReader[]): Map<string, StaffReader> {
  const inHand = new Map<string, StaffReader>();
  for (const reader of readers) {
    if (!reader.authorId || inHand.has(reader.authorId)) continue;
    if (reader.status === "drafting" || reader.status === "proposed") inHand.set(reader.authorId, reader);
  }
  return inHand;
}

/** What a proposal card says about a source, and what it asks the operator to pick. A service source asks for nothing. */
export function describeSource(source: ProposedSource, readers: StaffReader[], serviceName?: string): { kind: string; pick: string; placeholder: string } {
  if (source.kind === "service") {
    return { kind: `${source.service?.operation ?? "an operation"} on ${serviceName ?? "a service"}, read in code`, pick: "", placeholder: "" };
  }
  if (source.kind === "folder") {
    const info = readerOf(source.reader, readers);
    const pattern = patternOf(source, readers);
    const kind =
      info?.kind === "built_in"
        ? `folder of ${info.files}, ${pattern}`
        : info?.kind === "staff"
          ? `folder of ${pattern} files, read by ${info.reader ? `the ${info.reader.name} reader` : "a reader staff wrote"}`
          : `folder of ${pattern} files`;
    return { kind, pick: "path to the folder on this PC", placeholder: `C:\\Users\\you\\Documents\\${source.label}` };
  }
  return { kind: "calendar file", pick: "path to the .ics file on this PC", placeholder: "C:\\Users\\you\\Documents\\calendar.ics" };
}

/** Where a card's preview stands, for the path it was asked for. */
export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "done"; path: string; preview: SourcePreview }
  | { status: "failed"; path: string; error: string };

export interface ApprovalGate {
  /** False while Approve stays disabled. */
  ready: boolean;
  /** Why, in a sentence for the card, or null when there is nothing to say. */
  reason: string | null;
  /** "blocked" when the source can't be approved as it stands, whatever the operator does on the card. */
  tone: "info" | "done" | "blocked";
}

/**
 * Whether a proposal's source can be approved yet. A folder on a reader staff wrote needs that
 * reader handed in, and a preview of the very path being approved: approving the supervisor also
 * approves the reader, so the operator sees what it reads before it runs for real.
 */
export function approvalGate(source: ProposedSource | null, readers: StaffReader[], path: string, preview: PreviewState): ApprovalGate {
  // A source on a service reads an account: the operator sees what it reads, and from which account, first.
  if (source?.kind === "service") {
    if (preview.status === "done") return { ready: true, reason: null, tone: "done" };
    if (preview.status === "failed") {
      return {
        ready: false,
        reason: "The preview couldn't read the service. If it is signed out, sign in from Access and preview again. Otherwise decline with what went wrong, so the Chief of Staff can propose again.",
        tone: "info",
      };
    }
    return { ready: false, reason: "Preview first: AiHub reads the account now, so you see what the supervisor would get.", tone: "info" };
  }
  const info = source?.kind === "folder" ? readerOf(source.reader, readers) : null;
  if (info?.kind !== "staff") return { ready: true, reason: null, tone: "info" };
  const reader = info.reader;
  if (!reader) {
    return { ready: false, reason: "The reader this folder needs isn't on file, so it isn't ready. Ask for it again in chat.", tone: "blocked" };
  }
  if (reader.status === "drafting") {
    return { ready: false, reason: `${reader.authorName ?? "The toolsmith"} is still writing the ${reader.name} reader. It isn't ready to approve yet.`, tone: "blocked" };
  }
  if (reader.status === "failed") {
    return { ready: false, reason: `The ${reader.name} reader was never finished, so it isn't ready. Ask for it again in chat.`, tone: "blocked" };
  }
  const trimmed = path.trim();
  const previewed = preview.status !== "idle" && preview.path === trimmed;
  if (trimmed && previewed && preview.status === "done") {
    return {
      ready: true,
      reason: reader.status === "approved" ? null : `Approving also approves the ${reader.name} reader, with the code shown.`,
      tone: "done",
    };
  }
  if (trimmed && previewed && preview.status === "failed") {
    return { ready: false, reason: "The preview couldn't read that folder. Fix the path and preview again.", tone: "info" };
  }
  return {
    ready: false,
    reason:
      reader.status === "approved"
        ? `Preview the folder first to see what the ${reader.name} reader finds there.`
        : `Preview the folder first: approving also approves the ${reader.name} reader${reader.authorName ? ` ${reader.authorName} wrote` : ""}, so see what it reads.`,
    tone: "info",
  };
}

/** One record a preview found, ready to show. */
export interface PreviewRow {
  key: string;
  title: string;
  /** The file it came from, or a calendar event's time. */
  detail: string | null;
  /** A few of its fields as text. */
  fields: Array<[string, string]>;
}

/** How long a field value may run on a preview row. */
const VALUE_LENGTH = 80;

/**
 * The rows of a preview's data: `{ records }` from a folder, `{ series, events }` from a calendar.
 * The data comes from the daemon untyped, so anything else gives no rows.
 */
export function previewRows(data: unknown, fieldLimit = 3): PreviewRow[] {
  if (!isObject(data)) return [];
  if (Array.isArray(data.records)) {
    return data.records.filter(isObject).map((record, index) => ({
      key: text(record.id) || `record-${index}`,
      title: text(record.title) || "(untitled)",
      detail: text(record.file) || text(record.time) || null,
      fields: isObject(record.fields) ? Object.entries(record.fields).slice(0, fieldLimit).map(([name, value]) => [name, showValue(value)]) : [],
    }));
  }
  if (Array.isArray(data.events)) {
    return data.events.filter(isObject).map((event, index) => ({
      key: text(event.id) || `event-${index}`,
      title: text(event.title) || "(untitled)",
      detail: text(event.when) || null,
      fields: (["location", "organizer", "status"] as const)
        .filter((name) => event[name] !== undefined && event[name] !== null && event[name] !== "")
        .slice(0, fieldLimit)
        .map((name) => [name, showValue(event[name])]),
    }));
  }
  return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** A field value on one short line. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const raw = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line) return "—";
  return line.length > VALUE_LENGTH ? `${line.slice(0, VALUE_LENGTH - 1).trimEnd()}…` : line;
}
