import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { RunTurnOptions, TurnResult } from "../runtime/types.ts";
import { verifyConnection } from "../sources/collect.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "../staff/chief-of-staff.ts";
import { Store } from "../store/store.ts";
import { runMorningBriefing } from "./morning.ts";

const SAMPLE = fileURLToPath(new URL("../../test/fixtures/work.ics", import.meta.url));
const MONDAY = new Date("2026-11-09T05:00:00.000Z");
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The supervisor reports every new or changed record, plus one item that cites nothing. The Chief of Staff echoes its input. */
async function respond(input: string, options: RunTurnOptions): Promise<TurnResult> {
  if (input.includes("BEGIN SOURCE DATA")) {
    const data = input.slice(input.indexOf("BEGIN SOURCE DATA") + 18, input.indexOf("END SOURCE DATA"));
    const records = JSON.parse(data) as Array<{ id: string; change: string; title: string; when: string }>;
    const items = records
      .filter((record) => record.change !== "upcoming" && record.title !== "Standup")
      .map((record) => ({ title: `${record.title} (${record.change})`, detail: record.when, urgency: "today", sourceRef: record.id }));
    items.push({ title: "Made up", detail: "", urgency: "fyi", sourceRef: "nothing-collected" });
    const filed = await options.onToolCall({ name: "aihub_submit_report", arguments: { summary: `${records.length} changes.`, items } });
    return { status: "completed", text: filed.text, error: null, usage };
  }
  return { status: "completed", text: `BRIEFING\n${input}`, error: null, usage };
}

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "aihub-morning-"));
  dirs.push(dir);
  const calendar = join(dir, "work.ics");
  copyFileSync(SAMPLE, calendar);
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  runtime.respond = respond;
  const office = new Office({ store, runtime, vaultDir: join(dir, "vault") });
  office.start();
  store.upsertAgent({ id: "work-schedule", name: "Elin", title: "Work Schedule Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
  const responsibility = store.createResponsibility({ ownerId: "work-schedule", title: "Work schedule", scope: "", standingInstructions: "", expiresAt: null });
  store.createRoutine({ ownerId: "work-schedule", responsibilityId: responsibility.id, title: "Work schedule", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4 });
  const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path: calendar });
  store.grant("work-schedule", connection.id, ["read"]);
  verifyConnection(store, connection.id, MONDAY);
  return { store, runtime, office, responsibility, calendar };
}

const turnCount = (runtime: FakeRuntime) => runtime.calls.filter((call) => call.startsWith("turn ")).length;
const titles = (items: Array<{ title: string }>) => items.map((item) => item.title).sort();

describe("Morning briefing", () => {
  it("turns calendar changes into items that are new once, and posts the briefing", async () => {
    const { office, store, runtime, responsibility } = setUp();

    const first = await runMorningBriefing(office, { now: MONDAY });
    const [section] = first.sections;
    assert.equal(section?.status, "reported");
    assert.deepEqual(titles(store.itemsOf(responsibility.id, ["open"])), [
      "1:1 with Erik (new)",
      "Company offsite (new)",
      "Project review (new)",
      "Q4 planning (new)",
    ]);
    assert.ok(store.recentActivity(50).some((entry) => entry.summary === 'Left out "Made up": it cites no collected record'));
    const [posted] = store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID);
    assert.equal(posted?.kind, "briefing");
    const report = [...runtime.contexts.values()].find((context) => context.options.profile === "data")!;
    assert.match(report.options.instructions, /This is your first look/);

    // Same calendar, same day: no data turn, and the open items are carried over in short.
    const turns = turnCount(runtime);
    const second = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(second.sections[0]?.status, "nothing_new");
    assert.equal(turnCount(runtime), turns + 1, "only the compose turn");
    assert.match(second.text, /Checked; nothing new[\s\S]*Still open from earlier briefings: .*Q4 planning \(new\)/);
  });

  it("keeps a dismissed item out until its event changes", async () => {
    const { office, store, responsibility, calendar } = setUp();
    await runMorningBriefing(office, { now: MONDAY });
    const erik = store.itemsOf(responsibility.id, ["open"]).find((item) => item.title.startsWith("1:1 with Erik"))!;
    const review = store.itemsOf(responsibility.id, ["open"]).find((item) => item.title.startsWith("Project review"))!;
    store.closeItem(erik.id, "dismissed", null);
    store.closeItem(review.id, "resolved", "Moved it myself");

    writeFileSync(calendar, readFileSync(calendar, "utf8").replace("SUMMARY:Company offsite", "LOCATION:Skansen\r\nSUMMARY:Company offsite"));
    const unchanged = await runMorningBriefing(office, { now: MONDAY });
    assert.doesNotMatch(unchanged.text, /1:1 with Erik/);
    assert.match(unchanged.text, /Resolved since the last briefing: Project review \(new\) \(Moved it myself\)/);

    writeFileSync(calendar, readFileSync(calendar, "utf8").replace("T090000\r\nDTEND;TZID=Europe/Stockholm:20261113T093000", "T100000\r\nDTEND;TZID=Europe/Stockholm:20261113T103000"));
    const moved = await runMorningBriefing(office, { now: MONDAY });
    assert.match(moved.text, /1:1 with Erik \(changed\)/);
    assert.equal(store.getItem(erik.id)!.state, "open", "new again, then delivered");
  });

  it("reports an unreadable source and skips an ended responsibility", async () => {
    const { office, store, runtime, responsibility, calendar } = setUp();
    rmSync(calendar);
    const unavailable = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(unavailable.sections[0]?.status, "unavailable");
    assert.match(unavailable.text, /Source unavailable: The calendar file isn't there any more/);
    assert.equal(store.getAgent("work-schedule")!.state, "waiting_for_access");

    store.endResponsibility(responsibility.id);
    const turns = turnCount(runtime);
    const ended = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual(ended.sections, []);
    assert.equal(turnCount(runtime), turns + 1);
  });
});
