// Local time in the operator's timezone, with Intl only. Briefings, budgets, and streaks count local days.

export const TIMEZONE = "Europe/Stockholm";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** 1 is Monday and 7 is Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function localParts(at: Date, timeZone = TIMEZONE): LocalParts {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(parts.weekday!) + 1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The local calendar date, such as "2026-11-09". */
export function localDate(at: Date, timeZone = TIMEZONE): string {
  const { year, month, day } = localParts(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The instant a local date and time such as "07:00" happens. Across a DST change, the first match wins. */
export function zonedInstant(date: string, time: string, timeZone = TIMEZONE): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  // Guess with the offset at the wanted wall time, then correct once for an offset change in between.
  let guess = wanted;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = localParts(new Date(guess), timeZone);
    const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += wanted - seen;
  }
  return new Date(guess);
}

/** The local date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 1 is Monday and 7 is Sunday. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

export function isWeekday(date: string): boolean {
  return weekdayOf(date) <= 5;
}
