import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../store/store.ts";
import { describeTime, recordRef } from "./calendar.ts";
import { collect, verifyConnection } from "./collect.ts";

const SAMPLE = fileURLToPath(new URL("../../test/fixtures/work.ics", import.meta.url));
const MONDAY = new Date("2026-11-09T05:00:00.000Z");
const AT_MONDAY = { now: MONDAY };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aihub-collect-"));
  dirs.push(dir);
  const path = join(dir, "work.ics");
  copyFileSync(SAMPLE, path);
  const store = new Store(":memory:");
  store.upsertAgent({ id: "schedule", name: "Elin", role: "supervisor", managerId: null, profile: "data", charter: "" });
  const responsibility = store.createResponsibility({ ownerId: "schedule", title: "Work schedule", scope: "", standingInstructions: "", expiresAt: null });
  const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path });
  return { store, responsibility, connection, path };
}

describe("Calendar collector", () => {
  it("verifies a connection by reading it", async () => {
    const { store, connection, path } = setup();
    assert.deepEqual(
      [(await verifyConnection(store, connection.id, AT_MONDAY)).status, store.getConnection(connection.id)!.detail],
      ["connected", "8 events in the next 7 days"],
    );
    rmSync(path);
    const failed = await verifyConnection(store, connection.id, AT_MONDAY);
    assert.equal(failed.status, "failed");
    assert.match(failed.detail!, /isn't there any more/);

    const unchosen = store.createConnection({ kind: "ics_file", label: "Mailbox", path: "" });
    assert.equal((await verifyConnection(store, unchosen.id, AT_MONDAY)).detail, "No calendar file has been chosen yet.");
  });

  it("hands over changes with stable ids, and sees them again until the cursor is saved", async () => {
    const { store, responsibility, connection } = setup();
    const first = await collect(store, responsibility.id, connection, AT_MONDAY);
    assert.equal(first.unavailable, null);
    assert.equal(first.firstCheck, true);
    const planning = first.records.find((record) => record.title === "Q4 planning")!;
    assert.deepEqual(planning, {
      id: recordRef("q4-planning@work.example/2026-11-09T13:00:00.000Z"),
      change: "new",
      title: "Q4 planning",
      when: "Mon 9 Nov 10:00-11:30",
      organizer: "Anna Lindqvist",
      overlapsWith: ["Project review, Mon 9 Nov 10:30-11:30"],
    });
    const identity = first.identities.get(planning.id)!;
    assert.match(identity.version, /^new:[0-9a-f]{16}$/);
    assert.equal(identity.expiresAt, "2026-11-09T10:30:00.000Z");
    // Checked and clear reads differently from not checked: the list is there, empty.
    const tuesdayStandup = first.records.find((record) => record.title === "Standup" && String(record.when).startsWith("Tue"))!;
    assert.deepEqual(tuesdayStandup.overlapsWith, []);
    assert.equal(first.records.find((record) => record.title === "Company offsite")?.overlapsWith, undefined, "all-day events don't conflict");

    assert.equal((await collect(store, responsibility.id, connection, AT_MONDAY)).records.length, 8, "not committed yet");
    first.commit();
    assert.equal((await collect(store, responsibility.id, connection, AT_MONDAY)).records.length, 0);
  });

  it("says why a source is unavailable", async () => {
    const { store, responsibility, connection, path } = setup();
    rmSync(path);
    const collection = await collect(store, responsibility.id, connection, AT_MONDAY);
    assert.match(collection.unavailable!, /isn't there any more/);
    assert.equal(store.getConnection(connection.id)!.status, "failed");
  });

  it("describes times in Stockholm", () => {
    assert.equal(describeTime("2026-11-12T23:00:00.000Z", "2026-11-13T23:00:00.000Z", true), "Fri 13 Nov, all day");
    assert.equal(describeTime("2026-07-01T05:00:00.000Z", "2026-07-01T06:00:00.000Z", false), "Wed 1 Jul 07:00-08:00");
  });
});
