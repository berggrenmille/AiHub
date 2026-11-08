import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { DaemonEvent } from "@aihub/shared";
import { DASHBOARD_EXAMPLE, REPLY_EXAMPLE } from "@aihub/views";
import { runBriefing } from "../briefing/briefing.ts";
import { sampleSections, seedSampleStaff } from "../briefing/samples.ts";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { RunTurnOptions, TurnResult } from "../runtime/types.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT, CHIEF_OF_STAFF_ID } from "../staff/chief-of-staff.ts";
import { Store } from "../store/store.ts";
import { answerData } from "./data.ts";
import { MAX_FAILED_CHECKS } from "./views.ts";

const CALENDAR = fileURLToPath(new URL("../../test/fixtures/work.ics", import.meta.url));
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };
const done = (text: string): TurnResult => ({ status: "completed", text, error: null, usage });

function startOffice() {
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime });
  office.start();
  store.upsertAgent({ id: "prices", name: "Elsa", title: "Electricity Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "You watch electricity prices." });
  store.createResponsibility({ ownerId: "prices", title: "Electricity prices", scope: "", standingInstructions: "", expiresAt: null });
  const events: DaemonEvent[] = [];
  office.bus.subscribe(({ event }) => events.push(event));
  return { office, store, runtime, events };
}

async function chat(office: Office, conversationId: string, text: string) {
  const response = office.chat(conversationId, text);
  await office.queue.idle();
  return office.store.getRun(response.run.id)!;
}

describe("Views in chat", () => {
  it("shows a view under the staff member's reply, after it read the guide", async () => {
    const { office, store, runtime, events } = startOffice();
    const conversation = office.openChat("prices");
    const outcomes: Array<{ ok: boolean; text: string }> = [];
    runtime.respond = async (_input, options) => {
      outcomes.push(await options.onToolCall({ name: "aihub_view_guide", arguments: { for: "reply" } }));
      outcomes.push(await options.onToolCall({ name: "aihub_show_view", arguments: { title: "Prices today", program: REPLY_EXAMPLE } }));
      return done("Cheapest between 02:00 and 04:00.");
    };

    const run = await chat(office, conversation.id, "When is electricity cheap today?");

    assert.equal(run.state, "done");
    assert.match(outcomes[0]!.text, /^# Views[\s\S]*root = Stack/);
    assert.deepEqual(outcomes[1], { ok: true, text: "It shows under your reply. Still say in words what matters." });
    const reply = store.recentMessages(5, conversation.id).at(-1)!;
    assert.equal(reply.body, "Cheapest between 02:00 and 04:00.");
    const [view] = store.viewsOfRun(run.id);
    assert.deepEqual(
      { kind: view!.kind, agentId: view!.agentId, messageId: view!.messageId, title: view!.title, outside: view!.outside },
      { kind: "reply", agentId: "prices", messageId: reply.id, title: "Prices today", outside: "ask" },
      "a chat holds what the operator says, so outside images wait for a click",
    );
    assert.ok(events.some((event) => event.type === "view" && event.view.messageId === reply.id));
    assert.deepEqual(office.snapshot().views.map((shown) => shown.id), [view!.id]);
  });

  it("posts a reply that is only a view", async () => {
    const { office, store, runtime } = startOffice();
    runtime.respond = async (_input, options) => {
      await options.onToolCall({ name: "aihub_show_view", arguments: { title: "Prices", program: REPLY_EXAMPLE } });
      return done("");
    };
    const run = await chat(office, CHAT, "Show me the prices");
    const reply = store.recentMessages(5, CHAT).at(-1)!;
    assert.equal(reply.author, "agent");
    assert.equal(reply.body, "");
    assert.equal(store.viewsOfRun(run.id)[0]!.messageId, reply.id);
  });

  it("says what to fix, and after three failed checks has the staff member answer in text", async () => {
    const { office, store, runtime } = startOffice();
    const answers: string[] = [];
    runtime.respond = async (_input, options) => {
      for (let attempt = 0; attempt <= MAX_FAILED_CHECKS; attempt++) {
        const outcome = await options.onToolCall({ name: "aihub_show_view", arguments: { title: "Broken", program: `root = Stack([pie])\npie = PieChart([1])` } });
        answers.push(outcome.text);
      }
      return done("In words, then.");
    };
    const run = await chat(office, CHAT, "Chart it");

    assert.match(answers[0]!, /isn't shown:\n- pie: Unknown component "PieChart"[\s\S]*Fix them and call again\.$/);
    assert.match(answers[MAX_FAILED_CHECKS - 1]!, /That was the last try in this run: answer in text\.$/);
    assert.match(answers[MAX_FAILED_CHECKS]!, /no more are taken\. Answer in text this time\.$/);
    assert.deepEqual(store.viewsOfRun(run.id), []);
  });

  it("shows no view from a run that posts no reply, such as a task", async () => {
    const { office, store } = startOffice();
    const run = store.createRun({ agentId: "prices", kind: "follow_up", title: "Deliver the task" });
    const outcome = await office.gateway.call({ agentId: "prices", runId: run.id, profile: "data" }, { name: "aihub_show_view", arguments: { title: "Prices", program: REPLY_EXAMPLE } });
    assert.deepEqual(outcome, { ok: false, text: "aihub_show_view failed: A view shows only with a chat reply or a briefing section. Put this in words." });
  });
});

describe("Views on briefing sections", () => {
  /** Supervisors show a view and file a report; one reads an Office note first. The Chief of Staff echoes its input. */
  function respond(readsNote: string) {
    return async (input: string, options: RunTurnOptions): Promise<TurnResult> => {
      if (!input.includes("BEGIN SOURCE DATA")) return done(`BRIEFING\n${input}`);
      const source = /^Source: (.*)$/m.exec(input)![1]!;
      if (source === readsNote) await options.onToolCall({ name: "aihub_read_note", arguments: { title: "Household" } });
      await options.onToolCall({ name: "aihub_show_view", arguments: { title: `${source} at a glance`, program: REPLY_EXAMPLE } });
      const filed = await options.onToolCall({ name: "aihub_submit_report", arguments: { summary: `Checked ${source}.`, items: [] } });
      return done(filed.text);
    };
  }

  it("shows them under the briefing, loading outside images only for supervisors that hold no personal data", async () => {
    const store = new Store(":memory:");
    const runtime = new FakeRuntime();
    const office = new Office({ store, runtime });
    office.start();
    seedSampleStaff(store);
    office.notebook.writeFor(store.getAgentRecord(CHIEF_OF_STAFF_ID)!, "seed", "conversation", { title: "Household", body: "Two adults.", mode: "replace", folder: "office" });
    const sections = sampleSections().slice(0, 3);
    // The first section's supervisor reads a source; the second reads an Office note; the third neither.
    const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path: CALENDAR });
    store.grant(sections[0]!.agentId, connection.id, ["read"]);
    runtime.respond = respond(sections[1]!.source);

    const outcome = await runBriefing(office, sections);

    const briefing = store.recentMessages(5, CHAT).at(-1)!;
    assert.equal(briefing.kind, "briefing");
    const views = office.snapshot().views.filter((view) => view.messageId === briefing.id);
    assert.deepEqual(Object.fromEntries(views.map((view) => [view.title, `${view.kind}, ${view.outside}`])), {
      [`${sections[0]!.source} at a glance`]: "section, ask",
      [`${sections[1]!.source} at a glance`]: "section, ask",
      [`${sections[2]!.source} at a glance`]: "section, load",
    });
    assert.match(outcome.text, /A view shows under this section on the Today page: ".* at a glance"\. Point to it in a few words/);
  });
});

describe("Dashboards", () => {
  it("saves, updates, and removes the Chief of Staff's dashboards", async () => {
    const { office, store, runtime, events } = startOffice();
    let program = DASHBOARD_EXAMPLE;
    const saved: string[] = [];
    runtime.respond = async (_input, options) => {
      saved.push((await options.onToolCall({ name: "aihub_view_guide", arguments: { for: "dashboard" } })).text);
      saved.push((await options.onToolCall({ name: "aihub_save_dashboard", arguments: { title: "Open items", program } })).text);
      return done("Saved it.");
    };

    await chat(office, CHAT, "Make me a dashboard of open items");
    assert.match(saved[0]!, /^# Dashboards[\s\S]*office_items\(/);
    assert.match(saved[1]!, /^Saved "Open items"\. The operator opens it from the Dashboards tab/);
    const [dashboard] = store.dashboards();
    assert.deepEqual([dashboard!.kind, dashboard!.agentId, dashboard!.outside, dashboard!.messageId], ["dashboard", CHIEF_OF_STAFF_ID, "ask", null]);
    assert.ok(store.recentActivity(10).some((entry) => entry.summary === 'Vera made the dashboard "Open items"'));
    assert.ok(events.some((event) => event.type === "view" && event.view.id === dashboard!.id));

    // Saving under the same title changes it in place.
    program = DASHBOARD_EXAMPLE.replace('Heading("Open items", 1)', 'Heading("Items", 1)');
    await chat(office, CHAT, "Call it Items");
    assert.equal(store.dashboards().length, 1);
    assert.match(store.dashboards()[0]!.program, /Heading\("Items", 1\)/);
    assert.ok(store.recentActivity(10).some((entry) => entry.summary === 'Vera updated the dashboard "Open items"'));
    assert.ok(office.snapshot().views.some((view) => view.id === dashboard!.id), "dashboards are always in the snapshot");

    office.views.remove(dashboard!.id);
    assert.deepEqual(store.dashboards(), []);
    assert.ok(events.some((event) => event.type === "view_removed" && event.viewId === dashboard!.id));
  });

  it("is made only in chat, and a view under a message can't be removed", async () => {
    const { office, store, runtime } = startOffice();
    const report = store.createRun({ agentId: "prices", kind: "report", title: "Report" });
    const refused = await office.gateway.call({ agentId: "prices", runId: report.id, profile: "data" }, { name: "aihub_save_dashboard", arguments: { title: "x", program: DASHBOARD_EXAMPLE } });
    assert.equal(refused.ok, false);

    runtime.respond = async (_input, options) => {
      await options.onToolCall({ name: "aihub_show_view", arguments: { title: "Prices", program: REPLY_EXAMPLE } });
      return done("Here.");
    };
    const run = await chat(office, CHAT, "Chart it");
    assert.throws(() => office.views.remove(store.viewsOfRun(run.id)[0]!.id), /Only a dashboard can be removed/);
  });
});

describe("A dashboard's data", () => {
  it("answers from the office's records, filtered as asked", async () => {
    const { office, store } = startOffice();
    const now = new Date();
    const duty = store.listResponsibilities().find((candidate) => candidate.ownerId === "prices")!;
    const item = (sourceKey: string, title: string, urgency: "urgent" | "fyi") =>
      store.upsertItem({ responsibilityId: duty.id, sourceKey, sourceVersion: "1", title, detail: "", urgency, expiresAt: null }).item;
    item("a", "Price spike tonight", "urgent");
    const old = item("b", "Cheap Sunday", "fyi");
    store.closeItem(old.id, "dismissed", null);

    const open = (await answerData(office, "office_items", { staff: "elsa" }, now)) as { rows: Array<{ title: string; staff: string; urgency: string }> };
    assert.deepEqual(open.rows.map((row) => [row.title, row.staff, row.urgency]), [["Price spike tonight", "Elsa", "urgent"]]);
    const all = (await answerData(office, "office_items", { states: ["new", "dismissed"] }, now)) as { rows: unknown[] };
    assert.equal(all.rows.length, 2);

    await chat(office, CHAT, "Hello");
    const usage = (await answerData(office, "office_usage", { days: 3 }, now)) as { rows: Array<{ runs: number; turns: number }> };
    assert.equal(usage.rows.length, 3);
    assert.deepEqual([usage.rows[0]!.runs, usage.rows[2]!.runs, usage.rows[2]!.turns], [0, 1, 1]);

    const staff = (await answerData(office, "office_staff", {}, now)) as { rows: Array<{ name: string; model: string }> };
    assert.deepEqual(staff.rows.map((row) => row.name).sort(), ["Elsa", "Vera"]);

    for (const title of ["First", "Second", "Third"]) {
      store.createAssignment({ kind: "question", requesterId: CHIEF_OF_STAFF_ID, ownerId: "prices", parentId: null, conversationId: null, responsibilityId: null, title, brief: "?", runBudget: 1 });
    }
    const asked = (await answerData(office, "office_assignments", { staff: "Elsa", days: 7, limit: 2 }, now)) as { rows: Array<{ title: string }> };
    assert.equal(asked.rows.length, 2);

    await assert.rejects(answerData(office, "office_items", { staff: "Nobody" }, now), /Nobody on staff is called Nobody/);
    await assert.rejects(answerData(office, "send_mail", {}, now), /no data tool "send_mail"/);
    await assert.rejects(answerData(office, "office_runs", { days: 1000 }, now), /Invalid arguments for office_runs/);
  });

  it("reads a calendar now, with each event's times", async () => {
    const { office, store } = startOffice();
    store.createConnection({ kind: "ics_file", label: "Work calendar", path: CALENDAR });
    const reading = (await answerData(office, "source_records", { source: "work calendar", from: "2026-11-09", days: 1 })) as {
      events: Array<{ title: string; start: string; allDay: boolean }>;
    };
    assert.ok(reading.events.length > 0);
    assert.ok(reading.events.every((event) => !Number.isNaN(Date.parse(event.start))));
    await assert.rejects(answerData(office, "source_records", { source: "Bank" }), /no source called "Bank"/);
  });
});
