import { createHash } from "node:crypto";
import type { SourceConnection } from "@aihub/shared";
import { mapRecords, MappingProblem, outputOf, type MappedRecord } from "./mapping.ts";
import { matchesWords, messageOf, plural, type Identity, type SourceAdapter, type SourceContext, type SourceRecord } from "./source.ts";

// A source on a service (DESIGN.md › Connectors and capabilities): the collector calls one read
// operation with arguments fixed on the card, in code, and a mapping turns the answer into records.
// The daemon keys and versions each record and diffs it against the cursor, as it does for folders.
// A service's list is a window, such as the latest messages, so a record leaving it isn't news.

export const SERVICE_LIMITS = {
  /** Most changes one briefing hands a supervisor; the rest wait for the next check. */
  changesPerCheck: 60,
  /** Most records one read returns. */
  recordsPerRead: 100,
  /** Records the cursor remembers, so a record that comes back into the window isn't new again. */
  remembered: 5_000,
} as const;

export class ServiceProblem extends Error {}

interface ServiceCursor {
  /** Each record's version, by key. */
  seen: Record<string, string>;
  /** Keys, oldest first, so the cursor forgets the oldest past its limit. */
  order: string[];
}

export const serviceSource: SourceAdapter = {
  kind: "service",

  firstCheckNote:
    "This is your first look at this source, so the changes are a sample of what it already holds, not news. Report only what needs the operator's attention under your responsibility, and keep a note of what you'll watch.",

  async verify(connection, context) {
    const records = await fetchRecords(connection, context);
    return `${plural(records.length, "record")} in the latest read`;
  },

  async changes(connection, previous, context) {
    const records = await fetchRecords(connection, context);
    const before = previous as ServiceCursor | null;
    const changes = records
      .filter((record) => before?.seen[record.key] !== record.version)
      .map((record) => ({ change: before?.seen[record.key] === undefined ? ("new" as const) : ("changed" as const), record }));
    const firstCheck = before === null;
    const handed = changes.slice(0, SERVICE_LIMITS.changesPerCheck);
    // A first check records everything as seen and hands over a sample; later ones move past only what they hand over.
    const cursor: ServiceCursor = { seen: { ...before?.seen }, order: [...(before?.order ?? [])] };
    for (const { record } of firstCheck ? changes : handed) remember(cursor, record);
    const notes: string[] = [];
    if (changes.length > handed.length) {
      notes.push(
        firstCheck
          ? `The source holds ${records.length} records; these are the ${handed.length} newest. AiHub records the rest as seen.`
          : `${changes.length - handed.length} more changes wait for your next check.`,
      );
    }
    const identities = new Map<string, Identity>();
    const out = handed.map(({ change, record }): SourceRecord => {
      const id = refOf(connection, record.key);
      identities.set(id, { version: `${change}:${record.version}`, expiresAt: null, link: record.link });
      return recordFor(id, record, change);
    });
    return { firstCheck, records: out, identities, cursor, notes, detail: `${plural(records.length, "record")} in the latest read` };
  },

  async read(connection, query, context) {
    const records = await fetchRecords(connection, context);
    const matching = query.words.length
      ? records.filter((record) => matchesWords([record.title, ...Object.values(record.fields).map(String)].join("\n"), query.words))
      : records;
    const limit = Math.min(query.limit, SERVICE_LIMITS.recordsPerRead);
    const shownRecords = matching.slice(0, limit).map((record) => recordFor(refOf(connection, record.key), record));
    if (query.preview) {
      const first = shownRecords.length < matching.length ? ` Here are the first ${shownRecords.length}.` : "";
      return { summary: `${plural(records.length, "record")} in the latest read.${first}`, data: { records: shownRecords } };
    }
    const filtered = query.words.length ? ` match "${query.words.join(" ")}"` : "";
    const shown = shownRecords.length < matching.length ? ` Showing the first ${shownRecords.length}; narrow it with words to see others.` : "";
    return {
      summary: `${connection.label}: ${plural(matching.length, "record")}${filtered} out of ${records.length} in the latest read.${shown}`,
      data: { records: shownRecords },
    };
  },

  describeError(error) {
    if (error instanceof ServiceProblem || error instanceof MappingProblem) return error.message;
    return `The service couldn't be read: ${messageOf(error)}`;
  },
};

async function fetchRecords(connection: SourceConnection, context: SourceContext): Promise<MappedRecord[]> {
  const source = connection.service;
  if (!source) throw new ServiceProblem("This source names no service.");
  if (!context.callService) throw new ServiceProblem("This office can't reach services.");
  const result = await context.callService(source.serviceId, source.operation, source.arguments);
  if (!result.ok) throw new ServiceProblem(`The service answered with an error: ${cut(result.text.trim() || "it gave no reason", 300)}`);
  return newestFirst(mapRecords(outputOf(result), source.mapping));
}

/** Newest first when every record has a time that reads as a date; otherwise as the service listed them. */
function newestFirst(records: MappedRecord[]): MappedRecord[] {
  const times = records.map((record) => (record.time ? Date.parse(record.time) : Number.NaN));
  if (times.some((time) => Number.isNaN(time))) return records;
  return records.map((record, index) => ({ record, time: times[index]! })).sort((a, b) => b.time - a.time).map(({ record }) => record);
}

function remember(cursor: ServiceCursor, record: MappedRecord) {
  if (cursor.seen[record.key] === undefined) cursor.order.push(record.key);
  cursor.seen[record.key] = record.version;
  while (cursor.order.length > SERVICE_LIMITS.remembered) {
    const oldest = cursor.order.shift()!;
    delete cursor.seen[oldest];
  }
}

function recordFor(id: string, record: MappedRecord, change?: "new" | "changed"): SourceRecord {
  return {
    id,
    ...(change && { change }),
    title: record.title,
    ...(record.time && { time: record.time }),
    ...(record.link && { link: record.link }),
    fields: record.fields,
  };
}

/** The id the model sees: stable for a record in this connection, and opaque. */
function refOf(connection: SourceConnection, key: string): string {
  return `svc-${createHash("sha256").update(`${connection.id}\n${key}`).digest("hex").slice(0, 10)}`;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
