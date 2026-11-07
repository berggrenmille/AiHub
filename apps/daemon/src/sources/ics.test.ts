import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { diffCalendar, readCalendar, type CalendarRecord } from "./ics.ts";

const SAMPLE = readFileSync(new URL("../../test/fixtures/work.ics", import.meta.url), "utf8");
const MONDAY = { from: new Date("2026-11-09T05:00:00.000Z"), to: new Date("2026-11-16T05:00:00.000Z") };
const TUESDAY = { from: new Date("2026-11-10T05:00:00.000Z"), to: new Date("2026-11-17T05:00:00.000Z") };

const byTitle = (records: CalendarRecord[], title: string) => records.filter((record) => record.title === title);

/** Replaces one VEVENT block, found by its UID, with other lines (or removes it). */
function editEvent(text: string, uid: string, replace: (block: string) => string): string {
  return text.replace(new RegExp(`BEGIN:VEVENT\\r?\\nUID:${uid.replace(/\./g, "\\.")}[\\s\\S]*?END:VEVENT\\r?\\n`), replace);
}

describe("Calendar export", () => {
  it("expands recurring events in the window, with moved and skipped occurrences", () => {
    const records = readCalendar(SAMPLE, MONDAY);

    const [planning, ...others] = byTitle(records, "Q4 planning");
    assert.equal(others.length, 0, "the next Monday's planning starts after the window");
    assert.equal(planning!.key, "q4-planning@work.example/2026-11-09T13:00:00.000Z");
    assert.equal(planning!.start, "2026-11-09T09:00:00.000Z");
    assert.equal(planning!.end, "2026-11-09T10:30:00.000Z");
    assert.equal(planning!.organizer, "Anna Lindqvist");
    assert.equal(planning!.recurring, true);

    assert.deepEqual(
      byTitle(records, "Standup").map((record) => record.start),
      ["2026-11-09T08:15:00.000Z", "2026-11-10T08:15:00.000Z", "2026-11-11T08:15:00.000Z", "2026-11-13T08:15:00.000Z"],
    );
    assert.equal(byTitle(records, "Vendor demo")[0]!.status, "cancelled");
    assert.equal(byTitle(records, "Company offsite")[0]!.allDay, true);
    assert.equal(byTitle(records, "Project review")[0]!.location, "Room Saturnus");
    assert.equal(byTitle(records, "1:1 with Erik")[0]!.description, "Erik wants to discuss the on-call rota.");
  });

  it("reports everything as new on the first check, with conflicts found in code", () => {
    const diff = diffCalendar(null, readCalendar(SAMPLE, MONDAY), MONDAY);
    assert.equal(diff.firstCheck, true);
    assert.equal(diff.changes.length, 8, "the cancelled vendor demo is left out");
    assert.ok(diff.changes.every((change) => change.change === "new"));
    const planning = diff.changes.find((change) => change.record.title === "Q4 planning")!;
    assert.deepEqual(planning.overlaps?.map((other) => other.title), ["Project review"]);
  });

  it("finds nothing new when nothing changed", () => {
    const first = diffCalendar(null, readCalendar(SAMPLE, MONDAY), MONDAY);
    const second = diffCalendar(first.cursor, readCalendar(SAMPLE, MONDAY), MONDAY);
    assert.equal(second.firstCheck, false);
    assert.deepEqual(second.changes, []);
  });

  it("reports moved, removed, added, and cancelled events", () => {
    const first = diffCalendar(null, readCalendar(SAMPLE, MONDAY), MONDAY);
    let edited = editEvent(SAMPLE, "erik@work.example", (block) => block.replace("T090000", "T100000").replace("T093000", "T103000"));
    edited = editEvent(edited, "review@work.example", () => "");
    edited = editEvent(edited, "offsite@work.example", (block) => block.replace("SUMMARY:", "STATUS:CANCELLED\r\nSUMMARY:"));
    edited = edited.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\r\nUID:budget@work.example\r\nDTSTAMP:20261109T060000Z\r\nDTSTART;TZID=Europe/Stockholm:20261111T140000\r\nDTEND;TZID=Europe/Stockholm:20261111T150000\r\nSUMMARY:Budget sync\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    const second = diffCalendar(first.cursor, readCalendar(edited, MONDAY), MONDAY);
    // Changes in the order of the calendar, then what was removed.
    const summary = second.changes.map((change) => [change.change, change.record.title, change.was?.start ?? null]);
    assert.deepEqual(summary, [
      ["new", "Budget sync", null],
      ["cancelled", "Company offsite", first.cursor.records["offsite@work.example"]!.start],
      ["changed", "1:1 with Erik", "2026-11-13T08:00:00.000Z"],
      ["removed", "Project review", "2026-11-09T09:30:00.000Z"],
    ]);
  });

  it("calls events that enter the window as time passes upcoming, and lets past ones go", () => {
    const first = diffCalendar(null, readCalendar(SAMPLE, MONDAY), MONDAY);
    const next = diffCalendar(first.cursor, readCalendar(SAMPLE, TUESDAY), TUESDAY);
    assert.deepEqual(
      next.changes.map((change) => [change.change, change.record.title, change.record.start]),
      [
        ["upcoming", "Standup", "2026-11-16T08:15:00.000Z"],
        ["upcoming", "Q4 planning", "2026-11-16T13:00:00.000Z"],
      ],
    );
  });
});
