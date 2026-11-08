import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Office } from "../office.ts";
import { RecordingPlatform } from "../platform.ts";
import { Scheduler } from "../scheduler.ts";
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
  const platform = new RecordingPlatform();
  const office = new Office({ store, runtime, vaultDir: join(dir, "vault"), platform });
  office.start();
  store.upsertAgent({ id: "work-schedule", name: "Elin", title: "Work Schedule Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
  const responsibility = store.createResponsibility({ ownerId: "work-schedule", title: "Work schedule", scope: "", standingInstructions: "", expiresAt: null });
  store.createRoutine({ ownerId: "work-schedule", responsibilityId: responsibility.id, title: "Work schedule", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4 });
  const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path: calendar });
  store.grant("work-schedule", connection.id, ["read"]);
  await verifyConnection(store, connection.id, { now: MONDAY });
  return { store, runtime, office, responsibility, calendar, connection, platform };
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
    assert.equal(second.run!.state, "done");
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
    assert.match(unavailable.text, /Source unavailable: There's no calendar file at that path/);
    assert.equal(store.getAgent("work-schedule")!.state, "waiting_for_access");

    store.endResponsibility(responsibility.id);
    const turns = turnCount(runtime);
    const ended = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual(ended.sections, []);
    assert.equal(turnCount(runtime), turns);
  });
});

describe("Morning briefing when something is wrong", () => {
  const FOUR_ITEMS = ["1:1 with Erik (new)", "Company offsite (new)", "Project review (new)", "Q4 planning (new)"];
  const briefings = (store: Store) => store.recentMessages(20, CHIEF_OF_STAFF_CONVERSATION_ID).filter((message) => message.kind === "briefing");
  const reportContexts = (runtime: FakeRuntime) => [...runtime.contexts.values()].filter((context) => context.options.profile === "data").length;

  it("says a supervisor can't read its source once its access is revoked, without a turn of its own", async () => {
    const { office, store, runtime, connection } = await setUp();
    store.revokeGrant("work-schedule", connection.id);
    const outcome = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(outcome.sections[0]?.status, "unavailable");
    assert.match(outcome.text, /Source unavailable: Elin has nothing to check: no source, and no web search\./);
    assert.equal(reportContexts(runtime), 0, "no report turn");
  });

  it("sends the briefing without a failed supervisor's report, and reports its changes next time", async () => {
    const { office, store, runtime, responsibility } = await setUp();
    runtime.respond = async (input, options) =>
      input.includes("BEGIN SOURCE DATA") ? { status: "failed", text: "", error: "The model refused", usage: null } : respond(input, options);
    const first = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([first.sections[0]?.status, first.run?.state, first.waiting], ["missing", "done", null]);
    assert.match(first.text, /Missing: The model refused/);
    assert.equal(store.itemsOf(responsibility.id, ["new", "open"]).length, 0);

    runtime.respond = respond;
    const second = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(second.sections[0]?.status, "reported");
    assert.deepEqual(titles(store.itemsOf(responsibility.id, ["open"])), FOUR_ITEMS);
  });

  it("waits before any turn while Codex usage is used up, and briefs once it resets", async () => {
    const { office, store, runtime, responsibility } = await setUp();
    const resetsAt = new Date("2026-11-09T08:12:00.000Z");
    runtime.usage = { usedPercent: 100, resetsAt, exhausted: true };
    const waiting = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([waiting.run, waiting.waiting?.blocker, waiting.waiting?.resetsAt], [null, "usage", resetsAt]);
    assert.equal(turnCount(runtime), 0);
    assert.equal(store.recentRuns(10).filter((run) => run.kind === "briefing").length, 0, "no run for a briefing that never started");

    runtime.usage = { usedPercent: 0, resetsAt: null, exhausted: false };
    const delivered = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(delivered.run?.state, "done");
    assert.deepEqual(titles(store.itemsOf(responsibility.id, ["open"])), FOUR_ITEMS);
  });

  it("holds the briefing back when a turn runs out of usage or reach, and leaves its changes unreported", async () => {
    const { office, store, runtime, responsibility } = await setUp();
    const resetsAt = new Date("2026-11-09T08:12:00.000Z");
    runtime.usage = { usedPercent: 99, resetsAt, exhausted: false };
    runtime.respond = async (input, options) =>
      input.includes("BEGIN SOURCE DATA") ? { status: "failed", text: "", error: "Usage limit reached", usage: null, blocker: "usage" } : respond(input, options);
    const report = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([report.waiting?.blocker, report.waiting?.resetsAt, report.run?.state], ["usage", resetsAt, "failed"]);
    assert.equal(report.run?.error, "Waiting: The Codex plan's usage is used up.");
    assert.equal(briefings(store).length, 0);

    // The reports go through, but composing can't reach the service: the items stay undelivered.
    runtime.respond = async (input, options) =>
      input.includes("BEGIN SOURCE DATA") ? respond(input, options) : { status: "failed", text: "", error: "stream disconnected", usage: null, blocker: "offline" };
    const compose = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([compose.waiting?.blocker, compose.waiting?.detail], ["offline", "Codex can't reach the internet"]);
    assert.equal(briefings(store).length, 0);
    assert.deepEqual(titles(store.itemsOf(responsibility.id, ["new"])), FOUR_ITEMS, "found, not delivered");

    runtime.respond = respond;
    const delivered = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(delivered.run?.state, "done");
    assert.deepEqual(titles(store.itemsOf(responsibility.id, ["open"])), FOUR_ITEMS);
    assert.equal(briefings(store).length, 1);
  });

  it("holds the briefing back when the connection drops partway, though the turn's error doesn't say so", async () => {
    const { office, store, runtime, responsibility } = await setUp();
    // Offline, Codex fails a turn as "other" and can't even say who is signed in.
    let online = true;
    const account = runtime.account.bind(runtime);
    runtime.account = async () => {
      if (!online) throw new Error("workspace routing discovery failed");
      return account();
    };
    runtime.respond = async () => {
      online = false;
      return { status: "failed", text: "", error: "workspace routing discovery failed", usage: null, blocker: null };
    };
    const dropped = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([dropped.waiting?.blocker, dropped.waiting?.detail], ["offline", "Codex is unavailable: workspace routing discovery failed"]);
    assert.equal(store.itemsOf(responsibility.id, ["new", "open"]).length, 0);

    // Online again, a turn that fails for its own reasons is a gap in the briefing, not a wait.
    online = true;
    runtime.respond = async (input, options) =>
      input.includes("BEGIN SOURCE DATA") ? { status: "failed", text: "", error: "The model refused", usage: null } : respond(input, options);
    const gap = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([gap.waiting, gap.run?.state, gap.sections[0]?.status], [null, "done", "missing"]);
  });

  it("sends a quiet briefing while Codex is signed out, since it needs no turn", async () => {
    const { office, runtime } = await setUp();
    await runMorningBriefing(office, { now: MONDAY });
    runtime.signedIn = false;
    const turns = turnCount(runtime);
    const quiet = await runMorningBriefing(office, { now: MONDAY });
    assert.deepEqual([quiet.run?.state, quiet.waiting], ["done", null]);
    assert.equal(turnCount(runtime), turns);
  });

  it("says when a calendar export is more than a week old", async () => {
    const { office, runtime, calendar } = await setUp();
    const nineDaysAgo = new Date(MONDAY.getTime() - 9 * 86_400_000);
    utimesSync(calendar, nineDaysAgo, nineDaysAgo);
    const first = await runMorningBriefing(office, { now: MONDAY });
    assert.match(first.text, /Warning: The export is 9 days old, so changes made since then are missing\. Export it again\./);

    const turns = turnCount(runtime);
    const quiet = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(turnCount(runtime), turns, "still no turn on a quiet morning");
    assert.match(quiet.text, /\n\nWork schedule: The export is 9 days old/);
  });

  it("tells the operator outside the browser that the briefing is in, in counts only", async () => {
    const { office, store, platform } = await setUp();
    const scheduler = new Scheduler(office, { now: () => MONDAY });
    const routine = store.listRoutines().find((candidate) => candidate.trigger.type === "weekdays")!;
    const id = scheduler.runNow(routine.id);
    await scheduler.idle();
    assert.equal(store.getOccurrence(id)?.status, "delivered");
    assert.deepEqual(platform.notifications, [{ path: "/", title: "Your briefing is ready", body: "4 new items.", tag: "briefing" }]);
  });
});

describe("Morning briefing from web research", () => {
  const STORIES = {
    summit: { title: "Climate summit opens", sourceRef: "https://www.reuters.com/world/summit" },
    rates: { title: "Central bank holds rates", sourceRef: "https://www.bbc.com/news/rates" },
    chips: { title: "Chip export rules change", sourceRef: "https://apnews.com/chips" },
  };

  /** A researcher with web search and no source, alone in the office. The store's clock follows `clock.now`. */
  function setUpResearch() {
    const dir = mkdtempSync(join(tmpdir(), "aihub-research-"));
    dirs.push(dir);
    const clock = { now: MONDAY };
    const store = new Store(":memory:", () => clock.now);
    const runtime = new FakeRuntime();
    const office = new Office({ store, runtime, vaultDir: join(dir, "vault") });
    office.start();
    store.upsertAgent({ id: "nora", name: "Nora", title: "News Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
    const responsibility = store.createResponsibility({ ownerId: "nora", title: "World news", scope: "Politics and economics.", standingInstructions: "", expiresAt: null });
    store.createRoutine({ ownerId: "nora", responsibilityId: responsibility.id, title: "World news", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4 });
    office.setWebGrant("nora", { sites: [] });
    // The researcher searches once and files what it is told to; the Chief of Staff echoes its input.
    let filing: Array<{ title: string; sourceRef: string }> = [];
    runtime.respond = async (input, options) => {
      if (!input.startsWith("It is now")) return { status: "completed", text: `BRIEFING\n${input}`, error: null, usage };
      options.onEvent?.({ type: "web", query: "world news today", url: null });
      const items = filing.map((story) => ({ ...story, detail: "Published this morning.", urgency: "fyi" }));
      const filed = await options.onToolCall({ name: "aihub_submit_report", arguments: { summary: `${items.length} stories.`, items } });
      return { status: "completed", text: filed.text, error: null, usage };
    };
    const file = (...stories: Array<{ title: string; sourceRef: string }>) => {
      filing = stories;
    };
    const researchContexts = () => [...runtime.contexts.values()].filter((context) => context.options.instructions.includes("search the web for what your responsibility covers"));
    return { store, runtime, office, responsibility, clock, file, researchContexts };
  }

  it("runs one search turn with cached web search and keeps items keyed by their address", async () => {
    const { office, store, responsibility, file, researchContexts } = setUpResearch();
    file(STORIES.summit, STORIES.rates, { title: "Rumour", sourceRef: "story-3" });
    const outcome = await runMorningBriefing(office, { now: MONDAY });

    assert.equal(outcome.sections[0]?.status, "reported");
    const [context] = researchContexts();
    assert.deepEqual(context?.options.web, { mode: "cached", sites: [] });
    assert.match(context!.options.instructions, /You can search the web\. Search answers from an index/);
    assert.match(context!.inputs[0]!, /^It is now Monday, 9 November 2026 at 06:00 \(Europe\/Stockholm\)\.\nThis is your first briefing/);
    assert.deepEqual(store.itemsOf(responsibility.id, ["open"]).map((item) => item.sourceKey).sort(), [STORIES.rates.sourceRef, STORIES.summit.sourceRef]);
    const summaries = store.recentActivity(50).map((entry) => entry.summary);
    assert.ok(summaries.includes('Left out "Rumour": it cites no web address'));
    assert.ok(summaries.includes('Nora searched the web for "world news today"'));
    assert.match(outcome.text, /Section 1: World news\nSummary: 3 stories\./);
  });

  it("doesn't report a story twice, and leaves out yesterday's stories and their lapsing", async () => {
    const { office, store, responsibility, clock, file, researchContexts } = setUpResearch();
    file(STORIES.summit, STORIES.rates);
    await runMorningBriefing(office, { now: MONDAY });

    // Tuesday: the summit again, and one new story. Only the new one is new.
    const tuesday = new Date(MONDAY.getTime() + 86_400_000);
    clock.now = tuesday;
    file(STORIES.summit, STORIES.chips);
    const second = await runMorningBriefing(office, { now: tuesday });
    const outcome = second.sections[0]!;
    assert.equal(outcome.status, "reported");
    assert.deepEqual(outcome.status === "reported" && outcome.newItems.map((item) => item.title), [STORIES.chips.title]);
    assert.deepEqual(outcome.carried, [], "yesterday's stories aren't carried over");
    const input = researchContexts()[1]!.inputs[0]!;
    assert.match(input, /Your last briefing went out Monday, 9 November 2026 at 06:00/);
    assert.match(input, /BEGIN REPORTED ITEMS DATA[\s\S]*Climate summit opens[\s\S]*END REPORTED ITEMS DATA/);

    // Thursday: Monday's stories have lapsed, which isn't news.
    const thursday = new Date(MONDAY.getTime() + 3 * 86_400_000);
    clock.now = thursday;
    file();
    const third = await runMorningBriefing(office, { now: thursday });
    assert.deepEqual(third.sections[0]?.resolved, []);
    assert.deepEqual(store.itemsOf(responsibility.id, ["open"]).map((item) => item.title), []);
    assert.equal(store.itemsOf(responsibility.id, ["resolved"]).length, 3);
  });

  it("runs no turn for a supervisor without a source or web search, and says what to do", async () => {
    const { office, runtime, researchContexts } = setUpResearch();
    office.setWebGrant("nora", null);
    const outcome = await runMorningBriefing(office, { now: MONDAY });
    assert.equal(outcome.sections[0]?.status, "unavailable");
    assert.equal(researchContexts().length, 0);
    assert.match(outcome.text, /Nora has nothing to check: no source, and no web search\. Give Nora web search on the profile card/);
    assert.equal(runtime.calls.filter((call) => call.startsWith("turn ")).length, 1, "only the Chief of Staff composes");
  });
});
