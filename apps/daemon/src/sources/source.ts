import type { SourceConnection, SourceKind } from "@aihub/shared";
import type { FolderReader } from "./reader.ts";

// The source contract (DESIGN.md › Connectors and capabilities). Every kind of source, from a
// calendar export to a folder of notes, offers the same few operations, so collectors, the briefing,
// and the read tool work the same for all of them. A new kind of source adds an adapter here and
// changes nothing in the hierarchy, the scheduler, or delegation.

/** A record as the model sees it. `id` is what a report cites as its sourceRef. */
export interface SourceRecord {
  id: string;
  [field: string]: unknown;
}

/** What gives a record's item a stable identity, and when the item stops mattering. */
export interface Identity {
  version: string;
  expiresAt: string | null;
}

export interface SourceChanges {
  /** True when there was no cursor: everything the source holds is new to AiHub. */
  firstCheck: boolean;
  records: SourceRecord[];
  /** For each record id. */
  identities: Map<string, Identity>;
  /** The position to save once the changes have been reported. */
  cursor: unknown;
  /** Anything the supervisor should know about how these changes were cut, such as some held back. */
  notes: string[];
}

/** What a question or task asks of a source. Each kind uses what applies to it. */
export interface SourceQuery {
  /** For dated records: the first day, as YYYY-MM-DD in Stockholm time. Today when left out. */
  from?: string;
  days: number;
  /** Words every returned record must contain. */
  words: string[];
  limit: number;
}

export interface SourceReading {
  /** One or two sentences: what was read and how to understand it. */
  summary: string;
  /** The records, which the read tool hands over as source data. */
  data: unknown;
}

/** What an adapter gets from the office for one operation. */
export interface SourceContext {
  now: Date;
  /** A reader staff wrote, by its id: null unless the operator approved it. */
  staffReader?: (id: string) => FolderReader | null;
}

export interface SourceAdapter {
  kind: SourceKind;
  /** What a first check means for this kind of source, for the supervisor's report. */
  firstCheckNote: string;
  /** Reads the source to check it works. Returns what it found; throws when it can't be read. */
  verify(connection: SourceConnection, context: SourceContext): Promise<string>;
  /** What changed since the cursor. Throws when the source can't be read. */
  changes(connection: SourceConnection, previous: unknown, context: SourceContext): Promise<SourceChanges>;
  /** Reads records for a question or task. Throws when the source can't be read. */
  read(connection: SourceConnection, query: SourceQuery, context: SourceContext): Promise<SourceReading>;
  /** A read failure in the operator's terms, saying what to do about it. */
  describeError(error: unknown): string;
}

/** Raised for a connection whose file or folder the operator hasn't picked yet. */
export class NoPathChosen extends Error {}

/** Whether every word appears in the text, ignoring case. */
export function matchesWords(text: string, words: string[]): boolean {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word.toLowerCase()));
}

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
