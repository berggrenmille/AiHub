import { z } from "zod";

// Readers (DESIGN.md › Connectors and capabilities): a reader turns the text of one file into source
// records. Built-in readers are code in the daemon; a reader staff write runs in the sandbox, which
// hands back plain data. Either way the daemon checks what comes back with checkRecords, keys each
// record by its file, and versions it, so a reader can never decide an item's identity on its own.

/** One file a reader turns into records. The daemon reads it; the reader sees only its name and text. */
export interface ReaderFile {
  /** The path inside the source folder, with forward slashes, such as "2026/books.md". */
  name: string;
  text: string;
}

export type FieldValue = string | number | boolean | null;

/** One record as a reader returns it. */
export interface ReaderRecord {
  /** Stable within its file across edits, such as a row's id. Empty when the file is one record. */
  key: string;
  title: string;
  fields: Record<string, FieldValue>;
}

export type Reader = (file: ReaderFile) => ReaderRecord[];

export const READER_LIMITS = {
  recordsPerFile: 5_000,
  fieldsPerRecord: 40,
  keyLength: 200,
  titleLength: 200,
  fieldNameLength: 60,
  valueLength: 2_000,
} as const;

/** A reader returned something that isn't a list of records. The message says what, for the toolsmith. */
export class ReaderOutputError extends Error {}

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const RawRecord = z.object({
  key: z.union([z.string(), z.number()]).optional(),
  title: z.union([z.string(), z.number()]),
  fields: z.record(z.string(), Scalar).optional(),
});

/**
 * Checks a reader's output and clips it to the limits. Shapes that are wrong throw, since a
 * reader that returns them has a bug; text that is merely long is clipped.
 */
export function checkRecords(raw: unknown): ReaderRecord[] {
  if (!Array.isArray(raw)) throw new ReaderOutputError(`A reader returns a list of records, not ${describe(raw)}.`);
  if (raw.length > READER_LIMITS.recordsPerFile) {
    throw new ReaderOutputError(`A reader returns at most ${READER_LIMITS.recordsPerFile} records for one file, not ${raw.length}.`);
  }
  return raw.map((entry, index) => {
    const parsed = RawRecord.safeParse(entry);
    if (!parsed.success) {
      throw new ReaderOutputError(`Record ${index + 1} isn't { key, title, fields } with text, number, true/false, or null values: ${z.prettifyError(parsed.error)}`);
    }
    const fields = Object.entries(parsed.data.fields ?? {});
    if (fields.length > READER_LIMITS.fieldsPerRecord) {
      throw new ReaderOutputError(`Record ${index + 1} has ${fields.length} fields; a record has at most ${READER_LIMITS.fieldsPerRecord}.`);
    }
    return {
      key: clip(String(parsed.data.key ?? ""), READER_LIMITS.keyLength),
      title: clip(String(parsed.data.title), READER_LIMITS.titleLength) || "(untitled)",
      fields: Object.fromEntries(
        fields.map(([name, value]) => [clip(name, READER_LIMITS.fieldNameLength), typeof value === "string" ? clip(value, READER_LIMITS.valueLength) : finite(value)]),
      ),
    };
  });
}

function finite(value: FieldValue): FieldValue {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
