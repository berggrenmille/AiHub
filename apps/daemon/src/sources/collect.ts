import type { SourceConnection } from "@aihub/shared";
import type { Store } from "../store/store.ts";
import { TIMEZONE } from "../time.ts";
import { diffCalendar, readCalendarFile, type CalendarChange, type CalendarCursor } from "./ics.ts";

// Collectors (DESIGN.md › Architecture): code that reads a connection, compares it with the cursor,
// and hands the model only what changed. No model turn runs here.

/** How far ahead the calendar collector looks. */
export const CALENDAR_DAYS = 7;

/** A change as the supervisor sees it: `id` is what its report cites as the sourceRef. */
export interface SourceRecord {
  id: string;
  [field: string]: unknown;
}

export interface Collection {
  connection: SourceConnection;
  /** Why the source couldn't be read, or null when it was. */
  unavailable: string | null;
  firstCheck: boolean;
  records: SourceRecord[];
  /** For each record id: the version that gives its item a stable identity, and when it stops mattering. */
  identities: Map<string, { version: string; expiresAt: string | null }>;
  /** Saves the cursor. Call it once the changes have been reported, so a failed run sees them again. */
  commit: () => void;
}

/** Reads the connection to check it works, and records what it found. */
export function verifyConnection(store: Store, connectionId: string, now = new Date()): SourceConnection {
  const connection = store.getConnection(connectionId);
  if (!connection) throw new Error(`No connection ${connectionId}`);
  try {
    const records = readCalendarFile(connection.path, { from: now, to: new Date(now.getTime() + CALENDAR_DAYS * 86_400_000) });
    const upcoming = records.filter((record) => record.status !== "cancelled").length;
    return store.setConnectionStatus(connectionId, "connected", `${upcoming} event${upcoming === 1 ? "" : "s"} in the next ${CALENDAR_DAYS} days`);
  } catch (error) {
    return store.setConnectionStatus(connectionId, "failed", describeError(error));
  }
}

/** Collects what changed on a connection for a responsibility since its cursor. */
export function collect(store: Store, responsibilityId: string, connection: SourceConnection, now = new Date()): Collection {
  const window = { from: now, to: new Date(now.getTime() + CALENDAR_DAYS * 86_400_000) };
  const empty = { connection, firstCheck: false, records: [], identities: new Map(), commit: () => {} };
  let changes: CalendarChange[];
  let firstCheck: boolean;
  let cursor: CalendarCursor;
  try {
    const previous = store.getCursor(responsibilityId, connection.id) as CalendarCursor | null;
    ({ changes, firstCheck, cursor } = diffCalendar(previous, readCalendarFile(connection.path, window), window));
  } catch (error) {
    const failed = store.setConnectionStatus(connection.id, "failed", describeError(error));
    return { ...empty, connection: failed, unavailable: failed.detail };
  }
  if (connection.status !== "connected") connection = verifyConnection(store, connection.id, now);

  const identities = new Map<string, { version: string; expiresAt: string | null }>();
  const records = changes.map((change): SourceRecord => {
    const { record } = change;
    identities.set(record.key, { version: `${change.change}:${record.version}`, expiresAt: record.end });
    return {
      id: record.key,
      change: change.change,
      title: record.title,
      when: describeTime(record.start, record.end, record.allDay),
      ...(change.was && { was: describeTime(change.was.start, change.was.end, false) }),
      ...(record.location && { location: record.location }),
      ...(record.organizer && { organizer: record.organizer }),
      ...(record.status !== "confirmed" && change.change !== "removed" && { status: record.status }),
      ...(record.description && { notes: record.description }),
      ...(change.overlaps && { overlapsWith: change.overlaps.map((other) => `${other.title}, ${describeTime(other.start, other.end, false)}`) }),
    };
  });
  return {
    connection,
    unavailable: null,
    firstCheck,
    records,
    identities,
    commit: () => store.setCursor(responsibilityId, connection.id, cursor),
  };
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });

/** "Mon 9 Nov 10:00-11:30" in Stockholm time, or "Thu 12 Nov, all day". */
export function describeTime(start: string, end: string, allDay: boolean): string {
  const from = new Date(start);
  const to = new Date(end);
  if (allDay) return `${dayFormat.format(from)}, all day`;
  return `${dayFormat.format(from)} ${timeFormat.format(from)}-${timeFormat.format(to)}`;
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "The calendar file isn't there any more. Export it again or pick its new location.";
  if (code === "EACCES" || code === "EPERM") return "AiHub can't read the calendar file. Check its permissions.";
  return `The calendar file couldn't be read: ${error instanceof Error ? error.message : String(error)}`;
}
