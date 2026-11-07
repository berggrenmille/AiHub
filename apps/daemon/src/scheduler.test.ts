import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError } from "./errors.ts";
import { Office } from "./office.ts";
import { FakeRuntime } from "./runtime/fake-runtime.ts";
import { Scheduler, type SchedulerOptions } from "./scheduler.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import { Store } from "./store/store.ts";

// 9 November 2026 is a Monday. Stockholm is UTC+1 in November, so 07:00 there is 06:00Z.
const MONDAY_0700 = "2026-11-09T06:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Outcome = Awaited<ReturnType<NonNullable<SchedulerOptions["briefing"]>>>;

/** A briefing stub gets `done`, which records a real run, since occurrences point at runs. */
function setUp(start: string, briefing?: (done: () => Outcome) => Promise<Outcome>) {
  const dir = mkdtempSync(join(tmpdir(), "aihub-scheduler-"));
  dirs.push(dir);
  const clock = { now: new Date(start) };
  const store = new Store(":memory:", () => clock.now);
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime, vaultDir: dir });
  office.start();
  const calls: string[] = [];
  const done = (): Outcome => ({ run: { id: store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "briefing", title: "Morning briefing" }).id, state: "done", error: null } });
  const scheduler = new Scheduler(office, {
    now: () => clock.now,
    briefing: () => {
      calls.push(clock.now.toISOString());
      return briefing ? briefing(done) : Promise.resolve(done());
    },
  });
  office.scheduler = scheduler;
  const routine = store.listRoutines().find((candidate) => candidate.ownerId === CHIEF_OF_STAFF_ID && candidate.trigger.type === "weekdays")!;
  const at = async (iso: string) => {
    clock.now = new Date(iso);
    await scheduler.tick();
    await scheduler.idle();
  };
  return { store, runtime, office, scheduler, routine, calls, at, clock, done };
}

describe("The scheduler", () => {
  it("gives every office one weekday briefing at 07:00", () => {
    const { store, office, routine } = setUp(MONDAY_0700);
    office.start();
    assert.deepEqual(routine.trigger, { type: "weekdays", time: "07:00" });
    assert.equal(routine.timezone, "Europe/Stockholm");
    assert.equal(store.listRoutines().filter((candidate) => candidate.trigger.type === "weekdays").length, 1, "starting again adds none");
  });

  it("checks health an hour before and briefs once at 07:00", async () => {
    const { store, routine, calls, at } = setUp("2026-11-09T04:30:00.000Z");
    store.createConnection({ kind: "ics_file", label: "Family calendar", path: "C:/nowhere/family.ics" });

    await at("2026-11-09T04:30:00.000Z");
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-09:health`), null, "nothing at 05:30");

    await at("2026-11-09T05:10:00.000Z");
    const notice = store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]!;
    assert.equal(notice.kind, "notice");
    assert.match(notice.body, /^Before 07:00, a few things need you:\n- Family calendar: /);
    assert.equal(store.getConnection(store.listConnections()[0]!.id)?.status, "failed");
    await at("2026-11-09T05:40:00.000Z");
    assert.equal(store.recentMessages(10, CHIEF_OF_STAFF_CONVERSATION_ID).filter((message) => message.kind === "notice").length, 1, "one check a day");
    assert.deepEqual(calls, []);

    await at(MONDAY_0700);
    await at("2026-11-09T06:00:30.000Z");
    assert.deepEqual(calls, [MONDAY_0700]);
    const occurrence = store.getOccurrence(`${routine.id}:2026-11-09`)!;
    assert.deepEqual([occurrence.status, occurrence.attempts], ["delivered", 1]);
    assert.equal(store.getRun(occurrence.runId!)?.kind, "briefing");
  });

  it("stays quiet when the health check finds nothing", async () => {
    const { store, routine, at } = setUp("2026-11-09T05:30:00.000Z");
    await at("2026-11-09T05:30:00.000Z");
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-09:health`)?.status, "delivered");
    assert.equal(store.recentMessages(10, CHIEF_OF_STAFF_CONVERSATION_ID).filter((message) => message.kind === "notice").length, 0);
  });

  it("skips weekends and catches up later the same day, without a late health check", async () => {
    const { store, routine, calls, at } = setUp("2026-11-07T09:00:00.000Z");
    await at("2026-11-07T09:00:00.000Z");
    await at("2026-11-08T09:00:00.000Z");
    assert.deepEqual(calls, [], "Saturday and Sunday");

    await at("2026-11-09T08:30:00.000Z");
    assert.deepEqual(calls, ["2026-11-09T08:30:00.000Z"]);
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-09:health`), null);
  });

  it("retries a failed briefing once, after a pause, also after a restart", async () => {
    let fail = true;
    const { store, office, routine, calls, at, clock, done } = setUp(MONDAY_0700, (finished) =>
      fail ? Promise.reject(new Error("Codex timed out")) : Promise.resolve(finished()),
    );
    await at(MONDAY_0700);
    assert.deepEqual([store.getOccurrence(`${routine.id}:2026-11-09`)?.status, store.getOccurrence(`${routine.id}:2026-11-09`)?.detail], ["failed", "Codex timed out"]);
    await at("2026-11-09T06:10:00.000Z");
    assert.equal(calls.length, 1, "not before 15 minutes");
    await at("2026-11-09T06:16:00.000Z");
    assert.equal(calls.length, 2);
    await at("2026-11-09T07:00:00.000Z");
    assert.equal(calls.length, 2, "two attempts at most");
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-09`)?.attempts, 2);

    // Tuesday's briefing is cut short by a restart, and runs again after the pause.
    fail = false;
    clock.now = new Date("2026-11-10T06:00:00.000Z");
    store.claimOccurrence(`${routine.id}:2026-11-10`, routine.id, clock.now.toISOString());
    store.updateOccurrence(`${routine.id}:2026-11-10`, { status: "running", attempt: true });
    const restarted = new Scheduler(office, { now: () => clock.now, briefing: () => (calls.push("restarted"), Promise.resolve(done())) });
    restarted.start();
    restarted.stop();
    await restarted.idle();
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-10`)?.status, "failed");
    clock.now = new Date("2026-11-10T06:20:00.000Z");
    await restarted.tick();
    await restarted.idle();
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-10`)?.status, "delivered");
    assert.equal(calls.at(-1), "restarted");
  });

  it("marks a briefing with nobody reporting to it as skipped, without a turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-scheduler-"));
    dirs.push(dir);
    const now = new Date(MONDAY_0700);
    const store = new Store(":memory:", () => now);
    const runtime = new FakeRuntime();
    const office = new Office({ store, runtime, vaultDir: dir });
    office.start();
    const scheduler = new Scheduler(office, { now: () => now });
    await scheduler.tick();
    await scheduler.idle();
    const routine = store.listRoutines()[0]!;
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-09`)?.status, "skipped");
    assert.equal(runtime.calls.filter((call) => call.startsWith("turn ")).length, 0);
  });

  it("runs a briefing on request, one at a time", async () => {
    let finish!: () => void;
    const { store, scheduler, routine, calls } = setUp("2026-11-09T12:00:00.000Z", (finished) => new Promise((resolve) => (finish = () => resolve(finished()))));
    const id = scheduler.runNow(routine.id);
    assert.equal(id, `${routine.id}:manual:2026-11-09T12:00:00.000Z`);
    assert.throws(() => scheduler.runNow(routine.id), ConflictError);
    finish();
    await scheduler.idle();
    assert.equal(store.getOccurrence(id)?.status, "delivered");
    assert.equal(calls.length, 1);
  });

  it("says when each routine runs next", async () => {
    const { store, office, scheduler, routine, at } = setUp("2026-11-13T05:00:00.000Z");
    assert.equal(scheduler.nextRunAt(routine), "2026-11-13T06:00:00.000Z", "Friday morning");
    await at("2026-11-13T07:00:00.000Z");
    assert.equal(scheduler.nextRunAt(routine), "2026-11-16T06:00:00.000Z", "Monday, after Friday's briefing");
    assert.equal(office.snapshot().routines.find((candidate) => candidate.id === routine.id)?.nextRunAt, "2026-11-16T06:00:00.000Z");
    store.setRoutinePaused(routine.id, true);
    assert.equal(scheduler.nextRunAt(store.getRoutine(routine.id)!), null);
  });
});
