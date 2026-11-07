import { createHash } from "node:crypto";
import type { SourceConnection } from "@aihub/shared";
import { addDays, localDate, TIMEZONE, zonedInstant } from "../time.ts";
import { diffCalendar, readCalendarFile, type CalendarCursor, type CalendarWindow } from "./ics.ts";
import { errorCode, matchesWords, messageOf, NoPathChosen, plural, type Identity, type SourceAdapter, type SourceRecord } from "./source.ts";

// A calendar export (.ics) on the source contract. The collector looks a week ahead; the read tool
// reads any window up to a month.

/** How far ahead the calendar collector looks. */
export const CALENDAR_DAYS = 7;
/** Most events one read returns, so a long window can't flood the turn. */
const MAX_EVENTS = 200;

export const calendarSource: SourceAdapter = {
  kind: "ics_file",

  firstCheckNote:
    "This is your first look at this source, so the changes are everything in its window. Report what needs attention or preparation, such as conflicts and meetings that need something from the operator, not every routine meeting.",

  async verify(connection, { now }) {
    const records = readCalendarFile(pathOf(connection), weekFrom(now));
    const upcoming = records.filter((record) => record.status !== "cancelled").length;
    return `${plural(upcoming, "event")} in the next ${CALENDAR_DAYS} days`;
  },

  async changes(connection, previous, { now }) {
    const window = weekFrom(now);
    const { changes, firstCheck, cursor } = diffCalendar(previous as CalendarCursor | null, readCalendarFile(pathOf(connection), window), window);
    const identities = new Map<string, Identity>();
    const records = changes.map((change): SourceRecord => {
      const { record } = change;
      const id = recordRef(record.key);
      identities.set(id, { version: `${change.change}:${record.version}`, expiresAt: record.end });
      return {
        id,
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
    return { firstCheck, records, identities, cursor, notes: [] };
  },

  async read(connection, query, { now }) {
    const from = query.from ?? localDate(now, TIMEZONE);
    const days = Math.min(query.days, 31);
    const window = { from: zonedInstant(from, "00:00"), to: zonedInstant(addDays(from, days), "00:00") };
    const all = readCalendarFile(pathOf(connection), window);
    const matching = query.words.length
      ? all.filter((record) => matchesWords([record.title, record.location, record.organizer, record.description].filter(Boolean).join("\n"), query.words))
      : all;
    const records = matching.slice(0, Math.min(query.limit, MAX_EVENTS));
    // Each recurring series is listed once, so a reader can tell a series that starts late, or skips a
    // day, from data that is missing.
    const series = new Map<string, { id: string; title: string; repeats: string; since: string; skipsInWindow?: string[] }>();
    const inWindow = (at: string) => Date.parse(at) >= window.from.getTime() && Date.parse(at) < window.to.getTime();
    const events = records.map((record) => {
      const seriesId = record.series ? recordRef(record.key.split("/")[0]!) : null;
      if (record.series && seriesId && !series.has(seriesId)) {
        const skips = record.series.skipped.filter(inWindow).map((at) => describeStart(at, record.allDay));
        series.set(seriesId, {
          id: seriesId,
          title: record.title,
          repeats: record.series.rule,
          since: describeStart(record.series.since, record.allDay),
          ...(skips.length && { skipsInWindow: skips }),
        });
      }
      return {
        id: recordRef(record.key),
        title: record.title,
        when: describeTime(record.start, record.end, record.allDay),
        ...(record.location && { location: record.location }),
        ...(record.organizer && { organizer: record.organizer }),
        ...(record.status !== "confirmed" && { status: record.status }),
        ...(seriesId && { series: seriesId }),
        ...(record.description && { notes: record.description.slice(0, 300) }),
      };
    });
    const through = localDate(new Date(window.to.getTime() - 1), TIMEZONE);
    const filtered = query.words.length ? ` matching "${query.words.join(" ")}"` : "";
    const cut = records.length < matching.length ? ` (the first ${records.length} of ${matching.length})` : "";
    return {
      summary: `${connection.label}, ${from} through ${through}: ${plural(events.length, "event")}${filtered}${cut}. This is everything the file holds in the window. Occurrences of a recurring event point to its series, listed once with its rule, its first occurrence, and the occurrences the file skips in the window.`,
      data: { series: [...series.values()], events },
    };
  },

  describeError(error) {
    if (error instanceof NoPathChosen) return "No calendar file has been chosen yet.";
    const code = errorCode(error);
    if (code === "ENOENT") return "The calendar file isn't there any more. Export it again or pick its new location.";
    if (code === "EACCES" || code === "EPERM") return "AiHub can't read the calendar file. Check its permissions.";
    if (code === "EISDIR") return "That's a folder, not a calendar file. Pick the .ics file itself.";
    return `The calendar file couldn't be read: ${messageOf(error)}`;
  },
};

function pathOf(connection: SourceConnection): string {
  if (!connection.path.trim()) throw new NoPathChosen();
  return connection.path;
}

function weekFrom(now: Date): CalendarWindow {
  return { from: now, to: new Date(now.getTime() + CALENDAR_DAYS * 86_400_000) };
}

/**
 * The id the model sees and cites: stable for an event, so its item keeps its identity, but opaque.
 * The raw key holds the original time of a moved occurrence, which reads as a contradiction.
 */
export function recordRef(key: string): string {
  return `evt-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
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

/** One moment, with the year, such as "Mon 2 Nov 2026 09:15", or the day alone when all-day. */
export function describeStart(at: string, allDay: boolean): string {
  const moment = new Date(at);
  const year = localDate(moment, TIMEZONE).slice(0, 4);
  return `${dayFormat.format(moment)} ${year}${allDay ? "" : ` ${timeFormat.format(moment)}`}`;
}
