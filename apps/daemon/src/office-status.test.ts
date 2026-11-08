import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Office } from "./office.ts";
import { officeStatus } from "./office-status.ts";
import { RecordingPlatform } from "./platform.ts";
import { FakeRuntime } from "./runtime/fake-runtime.ts";
import { Scheduler, type BriefingResult } from "./scheduler.ts";
import { CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import { Store } from "./store/store.ts";

// Stockholm is UTC+1 in November. 14 November 2026 is a Saturday, 16 November a Monday.
const SATURDAY = "2026-11-14T12:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setUp(start: string, briefing?: () => Promise<BriefingResult | null>) {
  const dir = mkdtempSync(join(tmpdir(), "aihub-status-"));
  dirs.push(dir);
  const clock = { now: new Date(start) };
  const store = new Store(":memory:", () => clock.now);
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime, vaultDir: dir, platform: new RecordingPlatform() });
  office.start();
  office.scheduler = new Scheduler(office, { now: () => clock.now, briefing });
  const status = () => officeStatus(office, clock.now);
  return { store, runtime, office, clock, status };
}

/** A supervisor reporting to the briefing, as approving a proposal sets one up. */
function addSupervisor(store: Store) {
  store.upsertAgent({ id: "reading", name: "Clara", title: "Reading List Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
  const responsibility = store.createResponsibility({ ownerId: "reading", title: "Reading list", scope: "", standingInstructions: "", expiresAt: null });
  store.createRoutine({ ownerId: "reading", responsibilityId: responsibility.id, title: "Reading list", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4 });
  return responsibility;
}

describe("The office's status outside the browser", () => {
  it("says there is no briefing until someone reports to it", () => {
    const { store, status } = setUp(SATURDAY);
    const chief = store.getAgent(CHIEF_OF_STAFF_ID)!.name;
    assert.deepEqual(status(), { status: `No briefing yet: ask ${chief} to look after something`, needs: [], attention: false });
  });

  it("says when the next briefing is, in the office's own time", () => {
    const { store, clock, status } = setUp(SATURDAY);
    addSupervisor(store);
    assert.equal(status().status, "Next briefing Monday at 07:00");
    clock.now = new Date("2026-11-15T12:00:00.000Z");
    assert.equal(status().status, "Next briefing tomorrow at 07:00");
    clock.now = new Date("2026-11-16T05:30:00.000Z");
    assert.equal(status().status, "Next briefing today at 07:00");
  });

  it("says a briefing is being written, and one that waits, with when it tries again", async () => {
    let finish: (result: BriefingResult) => void = () => {};
    const { store, office, clock, status } = setUp("2026-11-16T06:00:00.000Z", () => new Promise((resolve) => (finish = resolve)));
    addSupervisor(store);
    const routine = store.listRoutines().find((candidate) => candidate.trigger.type === "weekdays")!;
    void office.scheduler!.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(status().status, "Writing your briefing…");

    finish({ run: null, waiting: { blocker: "signed_out", detail: "Codex isn't signed in", resetsAt: null } });
    await office.scheduler!.idle();
    clock.now = new Date("2026-11-16T06:01:00.000Z");
    assert.equal(store.getOccurrence(`${routine.id}:2026-11-16`)?.status, "waiting");
    assert.deepEqual(status(), { status: "Briefing waiting: Codex isn't signed in. Next try 07:15", needs: [], attention: true });
  });

  it("lists what needs the operator, and marks only what can't wait", async () => {
    const { store, office, runtime, status } = setUp(SATURDAY);
    const responsibility = addSupervisor(store);
    const item = (key: string, urgency: "urgent" | "fyi") =>
      store.upsertItem({ responsibilityId: responsibility.id, sourceKey: key, sourceVersion: "1", title: key, detail: "", urgency, expiresAt: null });

    item("library-book", "fyi");
    assert.deepEqual(status().needs, ["1 item in your inbox"]);
    assert.equal(status().attention, false, "an ordinary item can wait");

    item("double-debit", "urgent");
    assert.deepEqual(status().needs, ["2 items in your inbox, 1 urgent"]);
    assert.equal(status().attention, true);

    runtime.signedIn = false;
    await office.refreshRuntimeStatus();
    store.createProposal({ proposedBy: CHIEF_OF_STAFF_ID, runId: null, payload: {} as never });
    assert.deepEqual(status().needs, ["Codex isn't signed in", "A proposal to approve", "2 items in your inbox, 1 urgent"]);
  });
});
