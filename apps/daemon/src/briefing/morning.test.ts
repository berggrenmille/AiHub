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

async function setUp() {
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
  await verifyConnection(store, connection.id, { now: MONDAY });
  return { store, runtime, office, responsibility, calendar };
}

const turnCount = (runtime: FakeRuntime) => runtime.calls.filter((call) => call.startsWith("turn ")).length;
const titles = (items: Array<{ title: string }>) => items.map((item) => item.title).sort();

describe("Morning briefing", () => {
  it("turns calendar changes into items that are new once, and posts the briefing", async () => {
    const { office, store, runtime, responsibility } = await setUp();

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

    // Same calendar, same day: no turn at all. Code writes the quiet briefing and lists what is open.
    const turns = turnCount(runtime);
    const second = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(second.sections[0]?.status, "nothing_new");
    assert.equal(second.run.state, "done");
    assert.equal(turnCount(runtime), turns, "no turn on a quiet morning");
    assert.match(second.text, /^Nothing new since the last briefing\. Checked: Work schedule\.\n\nWork schedule\nStill open: .*Q4 planning \(new\)/);
    assert.equal(store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]?.body, second.text);
  });

  it("keeps a dismissed item out until its event changes", async () => {
    const { office, store, responsibility, calendar } = await setUp();
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

  it("closes open items the supervisor says no longer apply, and nothing else", async () => {
    const { office, store, runtime, responsibility, calendar } = await setUp();
    await runMorningBriefing(office, { now: MONDAY });
    const open = () => store.itemsOf(responsibility.id, ["open"]);
    const planning = open().find((item) => item.title.startsWith("Q4 planning"))!;
    const review = open().find((item) => item.title.startsWith("Project review"))!;

    writeFileSync(calendar, readFileSync(calendar, "utf8").replace("SUMMARY:Project review", "SUMMARY:Project review\r\nSTATUS:CANCELLED"));
    let shown: Array<{ sourceRef: string }> = [];
    runtime.respond = async (input, options) => {
      if (!input.includes("BEGIN SOURCE DATA")) return respond(input, options);
      const data = input.slice(input.indexOf("BEGIN SOURCE DATA") + 18, input.indexOf("END SOURCE DATA"));
      const [cancelled] = JSON.parse(data) as Array<{ id: string; status?: string; overlapsWith?: string[] }>;
      assert.deepEqual([cancelled?.id, cancelled?.status, cancelled?.overlapsWith], [review.sourceKey, "cancelled", undefined]);
      shown = JSON.parse(input.slice(input.indexOf("BEGIN OPEN ITEMS DATA") + 22, input.indexOf("END OPEN ITEMS DATA")));
      const filed = await options.onToolCall({
        name: "aihub_submit_report",
        arguments: {
          summary: "The review is off.",
          items: [{ title: "Project review cancelled", detail: "", urgency: "fyi", sourceRef: review.sourceKey }],
          noLongerApplies: [
            { sourceRef: planning.sourceKey, reason: "Project review was cancelled." },
            { sourceRef: review.sourceKey, reason: "Reported again in this report." },
            { sourceRef: "nothing-collected", reason: "Not an item." },
          ],
        },
      });
      return { status: "completed", text: filed.text, error: null, usage };
    };
    const next = await runMorningBriefing(office, { now: MONDAY });

    assert.ok(shown.some((item) => item.sourceRef === planning.sourceKey), "the open items were shown");
    assert.deepEqual([store.getItem(planning.id)?.state, store.getItem(planning.id)?.resolution], ["resolved", "Project review was cancelled."]);
    assert.deepEqual([store.getItem(review.id)?.state, store.getItem(review.id)?.title], ["open", "Project review cancelled"]);
    assert.match(next.text, /Resolved since the last briefing: Q4 planning \(new\) \(Project review was cancelled\.\)/);
    assert.doesNotMatch(next.text.match(/Still open from earlier briefings: .*/)?.[0] ?? "", /Q4 planning/);
    const journal = office.notebook.list().find((note) => note.ownerId === "work-schedule" && note.kind === "journal")!;
    assert.match(office.notebook.read(journal.path)?.body ?? "", /Closed "Q4 planning \(new\)": Project review was cancelled\./);
  });

  it("reports an unreadable source and skips an ended responsibility", async () => {
    const { office, store, runtime, responsibility, calendar } = await setUp();
    rmSync(calendar);
    const unavailable = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(unavailable.sections[0]?.status, "unavailable");
    assert.match(unavailable.text, /Source unavailable: The calendar file isn't there any more/);
    assert.equal(store.getAgent("work-schedule")!.state, "waiting_for_access");

    store.endResponsibility(responsibility.id);
    const turns = turnCount(runtime);
    const ended = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual(ended.sections, []);
    assert.equal(turnCount(runtime), turns);
  });
});
