import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, isWeekday, localDate, localParts, zonedInstant } from "./time.ts";

describe("Stockholm time", () => {
  it("finds the instant of a local time in winter and summer", () => {
    assert.equal(zonedInstant("2026-11-09", "07:00").toISOString(), "2026-11-09T06:00:00.000Z");
    assert.equal(zonedInstant("2026-07-01", "07:00").toISOString(), "2026-07-01T05:00:00.000Z");
    // The night summer time ends, 07:00 is already back on winter time.
    assert.equal(zonedInstant("2026-10-25", "07:00").toISOString(), "2026-10-25T06:00:00.000Z");
  });

  it("reads local dates and weekdays", () => {
    assert.equal(localDate(new Date("2026-11-08T23:30:00.000Z")), "2026-11-09");
    assert.equal(localParts(new Date("2026-11-09T06:00:00.000Z")).weekday, 1);
    assert.equal(addDays("2026-11-30", 1), "2026-12-01");
    assert.equal(isWeekday("2026-11-13"), true);
    assert.equal(isWeekday("2026-11-14"), false);
  });
});
