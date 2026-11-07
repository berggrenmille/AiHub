import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import ICAL from "ical.js";

// A calendar export (.ics) as a source (DESIGN.md › Connectors and capabilities). Code reads the
// file, expands recurring events into occurrences with stable keys, and diffs them against the
// cursor without a model turn. The model only sees what changed.

const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Occurrences of one recurring event to consider at most, so a runaway rule can't stall a check. */
const MAX_OCCURRENCES = 1_000;

export interface CalendarRecord {
  /** The event's UID, plus the occurrence's original start for a recurring event. Stable across edits. */
  key: string;
  /** Changes whenever anything the operator would care about changes. */
  version: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
}

export interface CalendarWindow {
  from: Date;
  to: Date;
}

/** Reads the file and returns the event occurrences that overlap the window. */
export function readCalendarFile(path: string, window: CalendarWindow): CalendarRecord[] {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) throw new Error(`The calendar file is ${Math.round(size / 1024 / 1024)} MB; AiHub reads up to 20 MB`);
  return readCalendar(readFileSync(path, "utf8"), window);
}

export function readCalendar(text: string, window: CalendarWindow): CalendarRecord[] {
  const calendar = new ICAL.Component(ICAL.parse(text));
  for (const timezone of calendar.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(timezone);

  // A recurring event's moved or edited occurrences arrive as separate VEVENTs with a RECURRENCE-ID.
  const masters = new Map<string, InstanceType<typeof ICAL.Event>>();
  const exceptions: Array<InstanceType<typeof ICAL.Event>> = [];
  for (const component of calendar.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(component);
    if (!event.uid || !event.startDate) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }
  const orphans: Array<InstanceType<typeof ICAL.Event>> = [];
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    if (master?.isRecurring()) master.relateException(exception);
    else orphans.push(exception);
  }

  const records: CalendarRecord[] = [];
  const from = window.from.getTime();
  const to = window.to.getTime();
  const overlaps = (start: Date, end: Date) => start.getTime() < to && end.getTime() > from;

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      const { start, end } = boundsOf(event.startDate, event.endDate);
      if (overlaps(start, end)) records.push(recordOf(event, event.uid, start, end, false));
      continue;
    }
    const iterator = event.iterator();
    for (let count = 0, next = iterator.next(); next && count < MAX_OCCURRENCES; count++, next = iterator.next()) {
      const details = event.getOccurrenceDetails(next);
      const { start, end } = boundsOf(details.startDate, details.endDate);
      if (start.getTime() >= to) break;
      if (!overlaps(start, end)) continue;
      const key = `${event.uid}/${details.recurrenceId.toJSDate().toISOString()}`;
      records.push(recordOf(details.item, key, start, end, true));
    }
  }
  for (const event of orphans) {
    const { start, end } = boundsOf(event.startDate, event.endDate);
    if (overlaps(start, end)) records.push(recordOf(event, `${event.uid}/${event.recurrenceId.toJSDate().toISOString()}`, start, end, true));
  }
  return records.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

type IcalTime = InstanceType<typeof ICAL.Time>;

function boundsOf(startDate: IcalTime, endDate: IcalTime | null): { start: Date; end: Date } {
  const start = startDate.toJSDate();
  // An event without an end lasts a day if it is all-day, and no time otherwise.
  const end = endDate ? endDate.toJSDate() : new Date(start.getTime() + (startDate.isDate ? 86_400_000 : 0));
  return { start, end };
}

function recordOf(event: InstanceType<typeof ICAL.Event>, key: string, start: Date, end: Date, recurring: boolean): CalendarRecord {
  const component = event.component;
  const status = String(component.getFirstPropertyValue("status") ?? "CONFIRMED").toLowerCase();
  const organizer = component.getFirstProperty("organizer");
  const organizerName = organizer ? String(organizer.getParameter("cn") ?? organizer.getFirstValue() ?? "").replace(/^mailto:/i, "") : "";
  const record: Omit<CalendarRecord, "version"> = {
    key,
    title: clean(event.summary) || "(no title)",
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: event.startDate.isDate,
    location: clean(event.location) || null,
    organizer: organizerName || null,
    description: clip(clean(event.description), 600) || null,
    status: status === "cancelled" ? "cancelled" : status === "tentative" ? "tentative" : "confirmed",
    recurring,
  };
  const version = createHash("sha256")
    .update(JSON.stringify([record.title, record.start, record.end, record.allDay, record.location, record.status, record.description, record.organizer]))
    .digest("hex")
    .slice(0, 16);
  return { ...record, version };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Diffing against the cursor --------------------------------------------------

export interface CalendarCursor {
  /** Where the last check's window ended. Events past it that show up now are upcoming, not new. */
  horizon: string;
  records: Record<string, { version: string; title: string; start: string; end: string }>;
}

export type CalendarChangeKind = "new" | "upcoming" | "changed" | "cancelled" | "removed";

export interface CalendarChange {
  change: CalendarChangeKind;
  record: CalendarRecord;
  /** For a changed, cancelled, or removed event: what it was at the last check. */
  was?: { title: string; start: string; end: string };
  /** Confirmed events in the window that overlap this one. */
  overlaps?: Array<{ key: string; title: string; start: string; end: string }>;
}

export interface CalendarDiff {
  /** True when there was no cursor: everything in the window is new to AiHub. */
  firstCheck: boolean;
  changes: CalendarChange[];
  cursor: CalendarCursor;
}

/**
 * What changed since the cursor. An event that is gone and already over isn't a change; one that
 * is gone before it happened was removed from the calendar.
 */
export function diffCalendar(previous: CalendarCursor | null, records: CalendarRecord[], window: CalendarWindow): CalendarDiff {
  const changes: CalendarChange[] = [];
  const current = new Map(records.map((record) => [record.key, record]));
  const horizon = previous ? Date.parse(previous.horizon) : Number.NEGATIVE_INFINITY;

  for (const record of records) {
    const before = previous?.records[record.key];
    if (!before) {
      if (record.status === "cancelled") continue;
      changes.push({ change: previous && Date.parse(record.start) >= horizon ? "upcoming" : "new", record });
    } else if (before.version !== record.version) {
      const was = { title: before.title, start: before.start, end: before.end };
      changes.push({ change: record.status === "cancelled" ? "cancelled" : "changed", record, was });
    }
  }
  for (const [key, before] of Object.entries(previous?.records ?? {})) {
    if (current.has(key) || Date.parse(before.end) <= window.from.getTime()) continue;
    const record: CalendarRecord = {
      key,
      version: "removed",
      title: before.title,
      start: before.start,
      end: before.end,
      allDay: false,
      location: null,
      organizer: null,
      description: null,
      status: "cancelled",
      recurring: key.includes("/"),
    };
    changes.push({ change: "removed", record, was: { title: before.title, start: before.start, end: before.end } });
  }

  // Conflicts are a condition code can check, so the model doesn't have to find them. Every timed
  // event that is still on gets the list, even an empty one, so "no conflicts" reads as checked.
  const busy = records.filter((record) => record.status !== "cancelled" && !record.allDay);
  for (const change of changes) {
    if (change.change === "removed" || change.record.status === "cancelled" || change.record.allDay) continue;
    const start = Date.parse(change.record.start);
    const end = Date.parse(change.record.end);
    const overlaps = busy
      .filter((other) => other.key !== change.record.key && Date.parse(other.start) < end && Date.parse(other.end) > start)
      .map(({ key, title, start, end }) => ({ key, title, start, end }));
    change.overlaps = overlaps;
  }

  const cursor: CalendarCursor = {
    horizon: window.to.toISOString(),
    records: Object.fromEntries(
      records.filter((record) => record.status !== "cancelled").map((record) => [record.key, { version: record.version, title: record.title, start: record.start, end: record.end }]),
    ),
  };
  return { firstCheck: previous === null, changes, cursor };
}
