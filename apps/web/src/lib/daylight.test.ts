import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daylightAt, formatHour, stockholmTime } from "./daylight.ts";

/** A Stockholm wall-clock time as a Date, given the UTC offset in force that day. */
const at = (date: string, time: string, offset: number) => new Date(`${date}T${time}:00+0${offset}:00`);

describe("Stockholm daylight", () => {
  it("reads the local time and offset in Stockholm", () => {
    assert.deepEqual(stockholmTime(new Date("2026-11-07T11:30:00Z")), { year: 2026, month: 11, day: 7, hour: 12.5, offset: 1 });
    assert.equal(stockholmTime(new Date("2026-06-21T10:00:00Z")).offset, 2);
  });

  it("estimates sunrise and sunset within minutes", () => {
    const november = daylightAt(at("2026-11-07", "12:00", 1));
    assert.equal(formatHour(november.sunrise!), "07:29");
    assert.equal(formatHour(november.sunset!), "15:35");
    const midsummer = daylightAt(at("2026-06-21", "12:00", 2));
    assert.equal(formatHour(midsummer.sunrise!), "03:31");
    assert.equal(formatHour(midsummer.sunset!), "22:08");
  });

  it("moves through night, dawn, day and dusk", () => {
    assert.equal(daylightAt(at("2026-11-07", "00:00", 1)).phase, "night");
    const dawn = daylightAt(at("2026-11-07", "07:00", 1));
    assert.equal(dawn.phase, "dawn");
    assert.ok(dawn.light > 0 && dawn.light < 1);
    assert.deepEqual([daylightAt(at("2026-11-07", "12:00", 1)).phase, daylightAt(at("2026-11-07", "12:00", 1)).light], ["day", 1]);
    assert.equal(daylightAt(at("2026-11-07", "16:00", 1)).phase, "dusk");
    assert.equal(daylightAt(at("2026-11-07", "19:00", 1)).phase, "night");
  });

  it("formats fractional hours", () => {
    assert.equal(formatHour(7.5), "07:30");
    assert.equal(formatHour(23.999), "00:00");
  });
});
