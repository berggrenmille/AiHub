import { createHash } from "node:crypto";
import type { RecordMapping } from "@aihub/shared";
import type { FieldValue } from "./reader.ts";

// A mapping turns a service's output into records (DESIGN.md › Connectors and capabilities). It is
// data, not code: where the list is, and which fields give each record its key, version, title, time,
// and link. The Chief of Staff writes it from the tool's declared output, and the card's preview checks it.

export class MappingProblem extends Error {}

export interface MappedRecord {
  key: string;
  version: string;
  title: string;
  time: string | null;
  link: string | null;
  fields: Record<string, FieldValue>;
}

const LIMITS = { fields: 24, value: 1_000, nested: 300 } as const;

/** The value at a dotted path, such as "data.items". An empty path is the value itself. */
export function valueAt(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  let current = value;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The output a mapping reads: the structured output, or text that parses as JSON. */
export function outputOf(result: { text: string; structured: unknown }): unknown {
  if (result.structured !== null && result.structured !== undefined) return result.structured;
  try {
    return JSON.parse(result.text);
  } catch {
    throw new MappingProblem("The service answered with text, not structured data, so a mapping can't read records from it.");
  }
}

/** The records a mapping finds in an output. Throws when the mapping doesn't fit it. */
export function mapRecords(output: unknown, mapping: RecordMapping): MappedRecord[] {
  const list = valueAt(output, mapping.list);
  if (!Array.isArray(list)) {
    const where = mapping.list ? `at "${mapping.list}"` : "at the top";
    throw new MappingProblem(`The output has no list ${where}. ${describeShape(output)}`);
  }
  const records: MappedRecord[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = scalar(valueAt(entry, mapping.key));
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const version = mapping.version ? scalar(valueAt(entry, mapping.version)) : null;
    const used = new Set([mapping.key, mapping.version, mapping.title, mapping.time, mapping.link].filter(Boolean));
    records.push({
      key,
      version: version ?? hash(JSON.stringify(entry)),
      title: scalar(valueAt(entry, mapping.title)) ?? "(untitled)",
      time: mapping.time ? scalar(valueAt(entry, mapping.time)) : null,
      link: mapping.link ? linkOf(valueAt(entry, mapping.link)) : null,
      fields: fieldsOf(entry as Record<string, unknown>, used),
    });
  }
  if (list.length > 0 && records.length === 0) {
    throw new MappingProblem(`None of the ${list.length} entries has a "${mapping.key}" to key it by. ${describeShape(list[0])}`);
  }
  return records;
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Only web addresses, so a record can't hand the office something else to open. */
function linkOf(value: unknown): string | null {
  const text = scalar(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function fieldsOf(entry: Record<string, unknown>, used: Set<string | undefined>): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  for (const [name, value] of Object.entries(entry)) {
    if (Object.keys(fields).length >= LIMITS.fields) break;
    if (used.has(name) || value === undefined) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") fields[name] = value;
    else if (typeof value === "string") fields[name] = cut(value, LIMITS.value);
    else fields[name] = cut(JSON.stringify(value), LIMITS.nested);
  }
  return fields;
}

/** What the output looks like, so a wrong mapping can be fixed: its top-level keys, or that it is a list. */
export function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `It is a list of ${value.length}.`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).slice(0, 12);
    return keys.length ? `Its fields: ${keys.join(", ")}.` : "It is an empty object.";
  }
  return `It is ${value === null ? "null" : typeof value}.`;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
