import { createHash } from "node:crypto";
import type { BuiltInReader } from "@aihub/shared";
import type { FieldValue, Reader, ReaderFile, ReaderRecord } from "./reader.ts";

// The built-in readers for folder sources. Each turns one file's text into records; the folder
// source keys them by file, versions them, and checks them like any reader's output.

export const BUILT_IN_READERS: Record<BuiltInReader, { reader: Reader; pattern: string; noun: string; nouns: string }> = {
  markdown: { reader: readMarkdown, pattern: "*.md", noun: "note", nouns: "notes" },
  text: { reader: readText, pattern: "*.txt", noun: "document", nouns: "documents" },
  csv: { reader: readCsv, pattern: "*.csv", noun: "row", nouns: "rows" },
  json: { reader: readJson, pattern: "*.json", noun: "record", nouns: "records" },
};

export function isBuiltInReader(name: string | null | undefined): name is BuiltInReader {
  return !!name && Object.hasOwn(BUILT_IN_READERS, name);
}

/** One note per file: the title from frontmatter or the first heading, frontmatter as fields, and the text. */
export function readMarkdown(file: ReaderFile): ReaderRecord[] {
  const { frontmatter, body } = splitFrontmatter(file.text);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const { title, ...fields } = frontmatter;
  return [{ key: "", title: String(title ?? heading ?? baseName(file.name)), fields: { ...fields, text: body.trim() } }];
}

/** One document per file: the first line as its title. */
export function readText(file: ReaderFile): ReaderRecord[] {
  const text = file.text.replace(/\r\n?/g, "\n").trim();
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  return [{ key: "", title: firstLine.slice(0, 120) || baseName(file.name), fields: { text } }];
}

/**
 * One record per row, with the header row naming the fields. Detects comma, semicolon, and tab
 * separators, as Swedish bank exports often use semicolons. Values stay text, so "0012" and
 * "1 234,50" keep their meaning. A column named id, key, or uid keys the rows; otherwise a row is
 * keyed by its content, so an edited row reads as one removed and one new.
 */
export function readCsv(file: ReaderFile): ReaderRecord[] {
  const text = file.text.replace(/^﻿/, "");
  const rows = parseCsv(text, detectSeparator(text)).filter((row) => row.some((cell) => cell.trim() !== ""));
  const [header, ...data] = rows;
  if (!header) return [];
  const names = uniqueNames(header.map((name, index) => name.trim() || `column ${index + 1}`));
  const keyColumn = names.findIndex((name) => /^(id|key|uid)$/i.test(name));
  return data.map((row) => {
    const fields = Object.fromEntries(names.map((name, index) => [name, (row[index] ?? "").trim()]));
    const values = Object.values(fields).filter(Boolean);
    return {
      key: keyColumn >= 0 && fields[names[keyColumn]!] ? String(fields[names[keyColumn]!]) : contentKey(row),
      title: values.slice(0, 3).join(" · ") || "(empty row)",
      fields,
    };
  });
}

/** A list of objects, an object holding one list, or a single object. */
export function readJson(file: ReaderFile): ReaderRecord[] {
  const parsed = JSON.parse(file.text.replace(/^﻿/, "")) as unknown;
  const list = Array.isArray(parsed) ? parsed : soleList(parsed) ?? [parsed];
  return list.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { key: contentKey([JSON.stringify(entry)]), title: String(JSON.stringify(entry)), fields: { value: flatten(entry) } };
    }
    const object = entry as Record<string, unknown>;
    const fields = Object.fromEntries(Object.entries(object).map(([name, value]) => [name, flatten(value)]));
    const keyName = Object.keys(object).find((name) => /^(id|key|uid)$/i.test(name));
    const titleName = Object.keys(object).find((name) => /^(title|name|subject|label)$/i.test(name));
    const firstText = Object.values(object).find((value) => typeof value === "string" && value.trim());
    return {
      key: keyName && object[keyName] != null ? String(object[keyName]) : contentKey([JSON.stringify(object)]),
      title: String(titleName ? object[titleName] : (firstText ?? "(untitled)")),
      fields,
    };
  });
}

// Helpers ---------------------------------------------------------------------

/** Frontmatter as simple "key: value" lines, with lists in brackets or as "- item" lines. */
export function splitFrontmatter(text: string): { frontmatter: Record<string, FieldValue>; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const frontmatter: Record<string, FieldValue> = {};
  let listKey: string | null = null;
  const list: string[] = [];
  const closeList = () => {
    if (listKey) frontmatter[listKey] = list.splice(0).join(", ");
    listKey = null;
  };
  for (const line of normalized.slice(4, end).split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      list.push(unquote(item[1]!));
      continue;
    }
    const pair = /^([A-Za-z0-9_][\w -]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    closeList();
    const [, key, raw] = pair;
    if (raw === "") {
      listKey = key!.trim();
      continue;
    }
    frontmatter[key!.trim()] = scalar(raw!);
  }
  closeList();
  const after = normalized.indexOf("\n", end + 1);
  return { frontmatter, body: after === -1 ? "" : normalized.slice(after + 1) };
}

function scalar(raw: string): FieldValue {
  const value = raw.trim();
  if (/^\[.*\]$/.test(value)) return value.slice(1, -1).split(",").map((part) => unquote(part)).filter(Boolean).join(", ");
  if (value === "true" || value === "false") return value === "true";
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function detectSeparator(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map((separator) => [separator, unquoted.split(separator).length - 1] as const);
  return counts.reduce((best, next) => (next[1] > best[1] ? next : best))[0];
}

/** RFC 4180: quoted fields may hold separators, line breaks, and doubled quotes. */
export function parseCsv(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} ${count}`;
  });
}

function soleList(value: unknown): unknown[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const lists = Object.values(value).filter(Array.isArray);
  return lists.length === 1 ? lists[0]! : null;
}

function flatten(value: unknown): FieldValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function contentKey(cells: string[]): string {
  return createHash("sha256").update(JSON.stringify(cells)).digest("hex").slice(0, 12);
}

function baseName(name: string): string {
  return (name.split("/").pop() ?? name).replace(/\.[^.]+$/, "");
}
