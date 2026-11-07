import type { ProposedSource, SourceConnection, SourceKind } from "@aihub/shared";
import type { Store } from "../store/store.ts";
import { calendarSource } from "./calendar.ts";
import { folderSource } from "./folder.ts";
import { BUILT_IN_READERS, isBuiltInReader } from "./readers.ts";
import type { Identity, SourceAdapter, SourceContext, SourceQuery, SourceReading, SourceRecord } from "./source.ts";

// Collectors (DESIGN.md › Architecture): code that reads a connection through its adapter, compares
// it with the cursor, and hands the model only what changed. No model turn runs here.

export type { SourceRecord } from "./source.ts";

const ADAPTERS: Record<SourceKind, SourceAdapter> = {
  ics_file: calendarSource,
  folder: folderSource,
};

export function adapterFor(kind: SourceKind): SourceAdapter {
  return ADAPTERS[kind];
}

export interface Collection {
  connection: SourceConnection;
  /** Why the source couldn't be read, or null when it was. */
  unavailable: string | null;
  firstCheck: boolean;
  /** What a first check means for this kind of source. */
  firstCheckNote: string;
  records: SourceRecord[];
  /** For each record id: the version that gives its item a stable identity, and when it stops mattering. */
  identities: Map<string, Identity>;
  /** How the changes were cut, such as some held back for the next check. */
  notes: string[];
  /** Saves the cursor. Call it once the changes have been reported, so a failed run sees them again. */
  commit: () => void;
}

/** Reads the connection to check it works, and records what it found. */
export async function verifyConnection(store: Store, connectionId: string, context: SourceContext = { now: new Date() }): Promise<SourceConnection> {
  const connection = store.getConnection(connectionId);
  if (!connection) throw new Error(`No connection ${connectionId}`);
  const adapter = adapterFor(connection.kind);
  try {
    return store.setConnectionStatus(connectionId, "connected", await adapter.verify(connection, context));
  } catch (error) {
    return store.setConnectionStatus(connectionId, "failed", adapter.describeError(error));
  }
}

/**
 * Checks a proposed source at the path the operator picked, before anything is created, so a wrong
 * path is fixed on the card. Returns what it found; throws with the reason it can't be read.
 */
export async function checkProposedSource(source: ProposedSource, path: string, context: SourceContext = { now: new Date() }): Promise<string> {
  const adapter = adapterFor(source.kind);
  const candidate = connectionFor(source, path);
  try {
    return await adapter.verify({ ...candidate, id: "candidate", status: "unverified", detail: null, verifiedAt: null }, context);
  } catch (error) {
    throw new Error(adapter.describeError(error));
  }
}

/** What a connection for a proposed source stores: the path, and for a folder its files and reader. */
export function connectionFor(source: ProposedSource, path: string): Pick<SourceConnection, "kind" | "label" | "path" | "pattern" | "reader"> {
  if (source.kind !== "folder") return { kind: source.kind, label: source.label, path, pattern: null, reader: null };
  const reader = source.reader ?? "text";
  const pattern = source.pattern?.trim() || (isBuiltInReader(reader) ? BUILT_IN_READERS[reader].pattern : "*");
  return { kind: "folder", label: source.label, path, pattern, reader };
}

/** What a proposed source would read at a path, for the operator to look at before approving. */
export async function previewProposedSource(source: ProposedSource, path: string, context: SourceContext, limit = 8): Promise<SourceReading> {
  const adapter = adapterFor(source.kind);
  const candidate = { ...connectionFor(source, path), id: "candidate", status: "unverified" as const, detail: null, verifiedAt: null };
  try {
    return await adapter.read(candidate, { days: 7, words: [], limit }, context);
  } catch (error) {
    throw new Error(adapter.describeError(error));
  }
}

/** Collects what changed on a connection for a responsibility since its cursor. */
export async function collect(store: Store, responsibilityId: string, connection: SourceConnection, context: SourceContext = { now: new Date() }): Promise<Collection> {
  const adapter = adapterFor(connection.kind);
  const base = { firstCheck: false, firstCheckNote: adapter.firstCheckNote, records: [], identities: new Map(), notes: [], commit: () => {} };
  let changes;
  try {
    changes = await adapter.changes(connection, store.getCursor(responsibilityId, connection.id), context);
  } catch (error) {
    const failed = store.setConnectionStatus(connection.id, "failed", adapter.describeError(error));
    return { ...base, connection: failed, unavailable: failed.detail };
  }
  if (connection.status !== "connected") connection = await verifyConnection(store, connection.id, context);
  const { cursor } = changes;
  return {
    ...base,
    connection,
    unavailable: null,
    firstCheck: changes.firstCheck,
    records: changes.records,
    identities: changes.identities,
    notes: changes.notes,
    commit: () => store.setCursor(responsibilityId, connection.id, cursor),
  };
}

/** Reads records for a question or task. Throws with the reason, in the operator's terms. */
export async function readSource(connection: SourceConnection, query: SourceQuery, context: SourceContext = { now: new Date() }): Promise<SourceReading> {
  const adapter = adapterFor(connection.kind);
  try {
    return await adapter.read(connection, query, context);
  } catch (error) {
    throw new Error(adapter.describeError(error));
  }
}
