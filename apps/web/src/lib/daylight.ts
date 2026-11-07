// The office's lighting follows the sun over Stockholm (DESIGN.md › The office experience). This
// estimates sunrise and sunset from the date with the usual solar formulas, accurate to a few
// minutes, which is plenty for a window tint.

export const TIME_ZONE = "Europe/Stockholm";
const LATITUDE = 59.33;
const LONGITUDE = 18.07;

export type DayPhase = "night" | "dawn" | "day" | "dusk";

export interface Daylight {
  phase: DayPhase;
  /** 0 at night to 1 in full daylight. */
  light: number;
  /** Local hours as a fraction, such as 16.5 for 16:30. */
  hour: number;
  /** Local sunrise and sunset in fractional hours. Null when the sun doesn't rise or set that day. */
  sunrise: number | null;
  sunset: number | null;
}

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The local date and time in Stockholm, and its offset from UTC in hours. */
export function stockholmTime(date: Date): { year: number; month: number; day: number; hour: number; offset: number } {
  const values: Record<string, number> = {};
  for (const part of parts.formatToParts(date)) if (part.type !== "literal") values[part.type] = Number(part.value);
  const hour = values.hour! + values.minute! / 60 + values.second! / 3600;
  const localAsUtc = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
  const offset = Math.round((localAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 3_600_000);
  return { year: values.year!, month: values.month!, day: values.day!, hour, offset };
}

const RAD = Math.PI / 180;

/**
 * Hours from solar noon until the sun's centre is at `altitude` degrees, or null when it stays
 * above it (polar day) or below it (polar night) all day. 0 when it never gets that high.
 */
function hourAngle(altitude: number, declination: number): number | null {
  const cos = (Math.sin(altitude * RAD) - Math.sin(LATITUDE * RAD) * Math.sin(declination)) / (Math.cos(LATITUDE * RAD) * Math.cos(declination));
  if (cos < -1) return null;
  if (cos > 1) return 0;
  return Math.acos(cos) / RAD / 15;
}

export function daylightAt(date: Date): Daylight {
  const local = stockholmTime(date);
  const dayOfYear = Math.round((Date.UTC(local.year, local.month - 1, local.day) - Date.UTC(local.year, 0, 0)) / 86_400_000);
  const declination = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  // The equation of time, in minutes: how far the sun runs ahead of or behind the clock.
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const noon = 12 - LONGITUDE / 15 - equationOfTime / 60 + local.offset;

  const rise = hourAngle(-0.833, declination);
  const civil = hourAngle(-6, declination);
  const sunrise = rise === null || rise === 0 ? null : noon - rise;
  const sunset = rise === null || rise === 0 ? null : noon + rise;

  let light: number;
  if (rise === null) light = 1;
  else if (rise === 0) light = 0;
  else {
    // Full light from half an hour after sunrise; dark from the end of civil twilight.
    const fromNoon = Math.abs(local.hour - noon);
    const bright = Math.max(0, rise - 0.5);
    const dark = civil === null ? 12 : Math.max(civil, rise + 0.25);
    light = fromNoon <= bright ? 1 : fromNoon >= dark ? 0 : 1 - (fromNoon - bright) / (dark - bright);
  }
  light = Math.round(light * 1000) / 1000;

  const phase: DayPhase = light >= 1 ? "day" : light <= 0 ? "night" : local.hour < noon ? "dawn" : "dusk";
  return { phase, light, hour: local.hour, sunrise, sunset };
}

/** Fractional hours as hh:mm. */
export function formatHour(hour: number): string {
  const minutes = Math.round(hour * 60);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
