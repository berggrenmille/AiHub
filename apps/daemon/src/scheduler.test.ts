import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError, InvalidRequestError } from "./errors.ts";
import { fileURLToPath } from "node:url";
import { Office, type Blocked } from "./office.ts";
import { RecordingPlatform } from "./platform.ts";
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
  const platform = new RecordingPlatform();
  const office = new Office({ store, runtime, vaultDir: dir, platform });
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
  return { store, runtime, office, scheduler, routine, calls, at, clock, done, platform, dir };
}

const notices = (store: Store) => store.recentMessages(20, CHIEF_OF_STAFF_CONVERSATION_ID).filter((message) => message.kind === "notice").map((message) => message.body);

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
    assert.match(notice.body, /^Before 07:00, one thing needs you:\n- Family calendar: /);
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
    store.startOccurrence(store.getOccurrence(`${routine.id}:2026-11-10`)!);
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

  it("briefs on weekends too once the operator turns them on, and stops when turned off", async () => {
    // Friday afternoon: the morning's briefing catches up, and the next wake is Monday's.
    const { store, scheduler, routine, calls, at, platform } = setUp("2026-11-13T13:00:00.000Z");
    await at("2026-11-13T13:00:00.000Z");
    assert.equal(platform.wake?.toISOString(), "2026-11-16T04:58:00.000Z");

    const updated = scheduler.setWeekends(routine.id, true);
    assert.deepEqual([updated.trigger, updated.nextRunAt], [{ type: "daily", time: "07:00" }, "2026-11-14T06:00:00.000Z"]);
    assert.equal(platform.wake?.toISOString(), "2026-11-14T04:58:00.000Z", "Saturday's");
    assert.ok(store.recentActivity(5).some((entry) => entry.summary === 'The operator set "Morning briefing" to run every day'));

    await at("2026-11-14T05:10:00.000Z");
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-14:health`)?.status, "delivered", "a health check on Saturday too");
    await at("2026-11-14T06:00:00.000Z");
    assert.deepEqual(calls, ["2026-11-13T13:00:00.000Z", "2026-11-14T06:00:00.000Z"]);

    assert.deepEqual(scheduler.setWeekends(routine.id, false).trigger, { type: "weekdays", time: "07:00" });
    await at("2026-11-15T09:00:00.000Z");
    assert.equal(calls.length, 2, "no Sunday briefing");
  });

  it("doesn't brief late on the weekend day weekends are turned on after the briefing's time", async () => {
    const { store, scheduler, routine, calls, at } = setUp("2026-11-14T10:00:00.000Z");
    scheduler.setWeekends(routine.id, true);
    await at("2026-11-14T10:00:00.000Z");
    assert.deepEqual(calls, []);
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-14`)?.status, "skipped");
    assert.equal(scheduler.nextRunAt(store.getRoutine(routine.id)!), "2026-11-15T06:00:00.000Z");
    await at("2026-11-15T06:00:00.000Z");
    assert.deepEqual(calls, ["2026-11-15T06:00:00.000Z"]);
  });

  it("keeps a briefing section on the briefing's days", () => {
    const { store, scheduler } = setUp(MONDAY_0700);
    const section = store.createRoutine({ ownerId: CHIEF_OF_STAFF_ID, responsibilityId: null, title: "Section", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 1 });
    assert.throws(() => scheduler.setWeekends(section.id, true), InvalidRequestError);
  });

  it("counts a weekend briefing in the streak, and never breaks it for a weekend without one", () => {
    const { store, office, clock, done } = setUp("2026-11-13T07:00:00.000Z");
    const deliverOn = (iso: string) => {
      clock.now = new Date(iso);
      office.finishRun(done()!.run!.id, "done");
    };
    for (const day of ["2026-11-12", "2026-11-13"]) deliverOn(`${day}T06:30:00.000Z`);
    clock.now = new Date("2026-11-16T05:00:00.000Z");
    assert.equal(office.officeStats(clock.now).briefingStreak, 2, "Thursday and Friday, across an empty weekend");
    deliverOn("2026-11-15T06:30:00.000Z");
    clock.now = new Date("2026-11-16T05:00:00.000Z");
    assert.equal(office.officeStats(clock.now).briefingStreak, 3, "and Sunday's");
    assert.equal(store.briefingDeliveries().length, 3);
  });
});

describe("The scheduler when Codex can't run", () => {
  const usedUp = (resetsAt: Date | null): Blocked => ({ blocker: "usage", detail: "The Codex plan's usage is used up", resetsAt });
  const signedOut: Blocked = { blocker: "signed_out", detail: "Codex isn't signed in", resetsAt: null };

  it("waits for Codex usage to reset, says so once, and delivers after", async () => {
    let blocked = true;
    // 08:12Z is 09:12 in Stockholm.
    const resetsAt = new Date("2026-11-09T08:12:00.000Z");
    const { store, scheduler, routine, calls, at, platform } = setUp(MONDAY_0700, (done) =>
      Promise.resolve(blocked ? { run: null, waiting: usedUp(calls.length === 1 ? resetsAt : null) } : done()),
    );
    const id = `${routine.id}:2026-11-09`;
    await at(MONDAY_0700);
    const waiting = store.getOccurrence(id)!;
    assert.deepEqual([waiting.status, waiting.retryAt, waiting.attempts], ["waiting", "2026-11-09T08:13:00.000Z", 0]);
    assert.deepEqual(notices(store), ["The briefing is waiting for Codex usage to reset at 09:12."]);
    assert.deepEqual(platform.notifications, [{ path: "/", title: "Your briefing is waiting", body: "The briefing is waiting for Codex usage to reset at 09:12.", tag: "briefing" }]);
    assert.equal(scheduler.nextRunAt(routine), "2026-11-09T08:13:00.000Z");
    assert.equal(platform.awake, false, "the PC may sleep while the wait is long");
    assert.equal(platform.wake?.toISOString(), "2026-11-09T08:11:00.000Z", "and wakes for the next try");

    await at("2026-11-09T07:00:00.000Z");
    assert.equal(calls.length, 1, "not before the reset");
    await at("2026-11-09T08:13:00.000Z");
    assert.equal(calls.length, 2);
    assert.deepEqual([store.getOccurrence(id)?.status, store.getOccurrence(id)?.retryAt], ["waiting", "2026-11-09T08:43:00.000Z"]);
    assert.equal(notices(store).length, 1, "the same reason isn't said twice");

    blocked = false;
    await at("2026-11-09T08:43:00.000Z");
    assert.deepEqual([store.getOccurrence(id)?.status, store.getOccurrence(id)?.attempts], ["delivered", 1]);
    assert.equal(platform.notifications.at(-1)?.title, "Your briefing is ready");
    assert.equal(platform.awake, false);
    assert.equal(platform.wake?.toISOString(), "2026-11-10T04:58:00.000Z", "Tuesday, before its health check");
  });

  it("keeps waiting across a restart, and gives up at the end of the day", async () => {
    const { store, office, routine, calls, at, clock, platform } = setUp(MONDAY_0700, () => Promise.resolve({ run: null, waiting: signedOut }));
    const id = `${routine.id}:2026-11-09`;
    await at(MONDAY_0700);
    assert.deepEqual([store.getOccurrence(id)?.status, store.getOccurrence(id)?.retryAt], ["waiting", "2026-11-09T06:15:00.000Z"]);
    assert.deepEqual(notices(store), [
      "The briefing is waiting. Codex isn't signed in. Sign in with `npm run codex -- login`. It tries again at 07:15, and until the end of the day.",
    ]);
    assert.equal(platform.awake, true, "a short wait keeps the PC awake");

    // The daemon restarts: the waiting briefing is still there, and tries again when due.
    clock.now = new Date("2026-11-09T06:15:00.000Z");
    const restarted = new Scheduler(office, { now: () => clock.now, briefing: () => (calls.push("restarted"), Promise.resolve({ run: null, waiting: signedOut })) });
    restarted.start();
    restarted.stop();
    await restarted.idle();
    assert.deepEqual(calls.at(-1), "restarted");

    clock.now = new Date("2026-11-09T22:55:00.000Z");
    await restarted.tick();
    await restarted.idle();
    const gaveUp = store.getOccurrence(id)!;
    assert.deepEqual([gaveUp.status, gaveUp.retryAt, gaveUp.detail], ["failed", null, "Gave up. Codex isn't signed in."]);
    assert.equal(notices(store).at(-1), "Today's briefing didn't go out. Codex isn't signed in. The next briefing covers what it would have.");
    assert.equal(platform.notifications.at(-1)?.title, "No briefing today");
    assert.equal(notices(store).length, 2);
  });

  it("gives up on a waiting briefing from an earlier day, such as after a night with the daemon off", async () => {
    const { store, routine, at } = setUp(MONDAY_0700, () => Promise.resolve({ run: null, waiting: signedOut }));
    await at(MONDAY_0700);
    await at("2026-11-10T05:00:00.000Z");
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-09`)?.status, "failed");
    assert.match(notices(store).at(-1)!, /^That day's briefing didn't go out\. Codex isn't signed in\./);
  });

  it("starts each briefing once with two schedulers on one database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-scheduler-"));
    dirs.push(dir);
    const clock = { now: new Date(MONDAY_0700) };
    const calls: string[] = [];
    let fail = true;
    const daemons = [1, 2].map((n) => {
      const store = new Store(join(dir, "aihub.db"), () => clock.now);
      const office = new Office({ store, runtime: new FakeRuntime(), vaultDir: join(dir, `vault-${n}`) });
      office.start();
      const scheduler = new Scheduler(office, {
        now: () => clock.now,
        briefing: async () => {
          calls.push(`daemon ${n}`);
          if (fail) throw new Error("Codex timed out");
          return { run: { id: store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "briefing", title: "Morning briefing" }).id, state: "done", error: null } };
        },
      });
      return { store, scheduler };
    });
    const both = async (iso: string) => {
      clock.now = new Date(iso);
      await Promise.all(daemons.map(({ scheduler }) => scheduler.tick()));
      await Promise.all(daemons.map(({ scheduler }) => scheduler.idle()));
    };
    try {
      const { store } = daemons[0]!;
      const routine = store.listRoutines().find((candidate) => candidate.trigger.type === "weekdays")!;
      assert.equal(store.listRoutines().length, 1, "the second daemon added no routine");
      await both(MONDAY_0700);
      assert.equal(calls.length, 1);
      fail = false;
      await both("2026-11-09T06:16:00.000Z");
      assert.equal(calls.length, 2, "the retry ran once too");
      await both("2026-11-09T06:40:00.000Z");
      assert.equal(calls.length, 2);
      assert.equal(store.getOccurrence(`${routine.id}:2026-11-09`)?.status, "delivered");
    } finally {
      for (const { store } of daemons) store.close();
    }
  });

  it("keeps the PC awake from just before the health check until the briefing is in, and sets the next wake", async () => {
    let finish!: () => void;
    const { at, platform, scheduler } = setUp("2026-11-09T04:50:00.000Z", (done) => new Promise((resolve) => (finish = () => resolve(done()))));
    await at("2026-11-09T04:50:00.000Z");
    assert.deepEqual([platform.awake, platform.wake?.toISOString()], [false, "2026-11-09T04:58:00.000Z"]);
    await at("2026-11-09T04:58:00.000Z");
    assert.deepEqual([platform.awake, platform.wake?.toISOString()], [true, "2026-11-10T04:58:00.000Z"]);

    // Friday's briefing: the next wake is Monday's.
    await at("2026-11-13T05:59:00.000Z");
    assert.equal(platform.awake, true);
    const briefing = at("2026-11-13T06:00:00.000Z");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(platform.awake, true, "awake while it runs");
    finish();
    await briefing;
    await scheduler.idle();
    assert.deepEqual([platform.awake, platform.wake?.toISOString()], [false, "2026-11-16T04:58:00.000Z"]);
  });

  it("catches an expired sign-in and an old calendar export in the health check, and says so outside the browser", async () => {
    const { store, runtime, at, platform, dir } = setUp("2026-11-09T05:10:00.000Z");
    runtime.signedIn = false;
    const calendar = join(dir, "work.ics");
    copyFileSync(fileURLToPath(new URL("../test/fixtures/work.ics", import.meta.url)), calendar);
    const tenDaysAgo = new Date(Date.parse("2026-11-09T05:10:00.000Z") - 10 * 86_400_000);
    utimesSync(calendar, tenDaysAgo, tenDaysAgo);
    const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path: calendar });

    await at("2026-11-09T05:10:00.000Z");
    const [notice] = notices(store);
    assert.match(notice!, /^Before 07:00, 2 things need you:\n- Codex isn't signed in\. Sign in with `npm run codex -- login`\.\n/);
    assert.match(notice!, /\n- Work calendar: The export is 10 days old, so changes made since then are missing\. Export it again\.$/);
    assert.deepEqual([store.getConnection(connection.id)?.status, store.getConnection(connection.id)?.detail?.endsWith("Export it again.")], ["connected", true]);
    const [alert] = platform.notifications;
    assert.deepEqual([alert?.title, alert?.tag, alert?.path], ["Before 07:00, 2 things need you", "health", "/"]);
    assert.match(alert!.body, /^Codex isn't signed in/);
  });

  it("has the Chief of Staff review the staff after a briefing when a sign calls for it", async () => {
    const { store, runtime, at } = setUp(MONDAY_0700, async (done) => ({
      run: done()!.run,
      sections: [{ agentId: "nora", heading: "Work calendar", warning: null, carried: [], resolved: [], status: "missing", run: null, reason: "The run failed" }],
    }));
    store.upsertAgent({ id: "nora", name: "Nora", title: "Calendar Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
    store.createResponsibility({ ownerId: "nora", title: "Work calendar", scope: "", standingInstructions: "", expiresAt: null });
    const inputs: string[] = [];
    runtime.respond = async (input) => {
      inputs.push(input);
      return { status: "completed", text: "NOTHING TO SUGGEST", error: null, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } };
    };
    const reviews = () => store.recentRuns(20).filter((run) => run.kind === "review").length;

    await at(MONDAY_0700);
    assert.equal(reviews(), 0, "one missing section is no sign yet");
    await at("2026-11-10T06:00:00.000Z");
    assert.equal(reviews(), 1);
    assert.match(inputs.at(-1)!, /Nora's section was missing from the last two briefings/);
    const [occurrence] = store.occurrencesIn("delivered").filter((candidate) => candidate.id.includes("2026-11-10") && !candidate.id.endsWith("health"));
    assert.ok(occurrence, "the briefing stays delivered");
  });

  it("tells the operator a manual briefing can't run, without waiting or retrying", async () => {
    const { store, scheduler, routine } = setUp("2026-11-09T12:00:00.000Z", () => Promise.resolve({ run: null, waiting: signedOut }));
    const id = scheduler.runNow(routine.id);
    await scheduler.idle();
    assert.deepEqual([store.getOccurrence(id)?.status, store.getOccurrence(id)?.retryAt], ["failed", null]);
    assert.equal(notices(store).at(-1), "The briefing can't run now. Codex isn't signed in. Sign in with `npm run codex -- login`.");
  });
});
