import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunKind, RunProfile } from "@aihub/shared";
import { Store } from "../store/store.ts";
import { Gateway, type Caller } from "./gateway.ts";
import { OFFICE_TOOLS } from "./tools.ts";
const NOTE_TOOLS = ["aihub_list_notes", "aihub_read_note", "aihub_write_note"];
const VIEW_TOOLS = ["aihub_view_guide", "aihub_show_view"];

function office() {
  const store = new Store(":memory:");
  store.upsertAgent({ id: "chief", name: "Chief of Staff", role: "chief_of_staff", managerId: null, profile: "conversation", charter: "" });
  store.upsertAgent({ id: "schedule", name: "Work Schedule", role: "supervisor", managerId: "chief", profile: "data", charter: "" });
  const chiefRun = store.createRun({ agentId: "chief", kind: "chat", title: "Reply" });
  const scheduleRun = store.createRun({ agentId: "schedule", kind: "report", title: "Check calendar" });
  return {
    store,
    gateway: new Gateway(store, OFFICE_TOOLS),
    chief: { agentId: "chief", runId: chiefRun.id, profile: "conversation" } satisfies Caller,
    supervisor: { agentId: "schedule", runId: scheduleRun.id, profile: "data" } satisfies Caller,
  };
}

describe("Gateway", () => {
  it("offers each run only the tools its role and profile allow", () => {
    const { gateway, chief, supervisor } = office();

    assert.deepEqual(gateway.specsFor(chief).map((tool) => tool.name), [
      "aihub_get_roster",
      "aihub_list_activity",
      "aihub_list_models",
      "aihub_propose_supervisor",
      "aihub_propose_policy",
      "aihub_propose_staff_change",
      "aihub_ask_colleague",
      "aihub_assign_task",
      "aihub_commission_reader",
      "aihub_list_services",
      "aihub_propose_service",
      ...NOTE_TOOLS,
      ...VIEW_TOOLS,
      "aihub_save_dashboard",
    ]);
    assert.deepEqual(gateway.specsFor({ ...chief, profile: "data" }).map((tool) => tool.name), ["aihub_ask_colleague", ...NOTE_TOOLS, ...VIEW_TOOLS, "aihub_save_dashboard"]);
    // A briefing report may carry a view, but never a dashboard.
    assert.deepEqual(gateway.specsFor(supervisor).map((tool) => tool.name), ["aihub_submit_report", ...NOTE_TOOLS, ...VIEW_TOOLS]);
    assert.deepEqual(gateway.specsFor({ ...supervisor, profile: "conversation" }).map((tool) => tool.name), [...NOTE_TOOLS, ...VIEW_TOOLS]);
  });

  it("offers each kind of run only the tools that kind allows", async () => {
    const { gateway, store, chief } = office();
    const asRun = (agentId: string, kind: RunKind, profile: RunProfile): Caller => ({
      agentId,
      runId: store.createRun({ agentId, kind, title: kind }).id,
      profile,
    });
    const names = (caller: Caller, asKind?: RunKind) => gateway.specsFor(caller, asKind).map((tool) => tool.name);

    // A task may ask a colleague and read its sources; an answer to a question may only read.
    assert.deepEqual(names(asRun("schedule", "assignment", "data")), ["aihub_ask_colleague", "aihub_recruit_worker", "aihub_read_source", ...NOTE_TOOLS]);
    assert.deepEqual(names(asRun("schedule", "question", "data")), ["aihub_read_source", ...NOTE_TOOLS]);
    assert.deepEqual(names(asRun("schedule", "follow_up", "data")), ["aihub_review_work", "aihub_read_source", ...NOTE_TOOLS, ...VIEW_TOOLS]);

    // A chat follow-up is offered the chat's tools, so the thread stays the same, but can't delegate again.
    const followUp = asRun("chief", "follow_up", "conversation");
    assert.deepEqual(names(followUp, "chat"), names(chief));
    const refused = await gateway.call(followUp, { name: "aihub_ask_colleague", arguments: { colleague: "Work Schedule", question: "Free on Friday?" } });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /not available to this run/);

    // A staff review reads counts only: no notes, sources, or views, and no delegation.
    const review = asRun("chief", "review", "conversation");
    assert.deepEqual(names(review), ["aihub_list_models", "aihub_propose_supervisor", "aihub_propose_staff_change"]);
    const notes = await gateway.call(review, { name: "aihub_read_note", arguments: { title: "Operator" } });
    assert.equal(notes.ok, false);
  });

  it("describes tool input as JSON Schema", () => {
    const { gateway, chief } = office();
    const activity = gateway.specsFor(chief).find((tool) => tool.name === "aihub_list_activity");

    assert.equal(activity?.inputSchema.type, "object");
    assert.equal(activity?.inputSchema.additionalProperties, false);
    assert.equal(activity?.inputSchema.$schema, undefined);
    assert.ok((activity?.inputSchema.properties as Record<string, unknown>).limit);
  });

  it("runs a permitted call and records it in the activity feed", async () => {
    const { gateway, chief, supervisor, store } = office();

    const calendar = store.createConnection({ kind: "ics_file", label: "Work calendar", path: "C:/work.ics" });
    store.setConnectionStatus(calendar.id, "connected", "8 events in the next 7 days");
    store.grant(supervisor.agentId, calendar.id, ["read"]);
    const outcome = await gateway.call(chief, { name: "aihub_get_roster", arguments: {} });

    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(outcome.text), [
      { name: "Chief of Staff", title: "", role: "chief_of_staff", manager: null, responsibility: null, state: "queued", sources: [] },
      {
        name: "Work Schedule",
        title: "",
        role: "supervisor",
        manager: "Chief of Staff",
        responsibility: null,
        state: "queued",
        sources: [{ label: "Work calendar", status: "connected", detail: "8 events in the next 7 days" }],
      },
    ]);
    assert.equal(store.recentActivity(1)[0]?.kind, "tool_call");
  });

  it("refuses a tool the caller may not use, even when the model names it", async () => {
    const { gateway, supervisor, store } = office();

    const outcome = await gateway.call(supervisor, { name: "aihub_get_roster", arguments: {} });

    assert.deepEqual(outcome, { ok: false, text: "aihub_get_roster is not available to this run." });
    assert.equal(store.recentActivity(1)[0]?.kind, "tool_refused");
  });

  it("refuses unknown tools and invalid arguments", async () => {
    const { gateway, chief } = office();

    assert.equal((await gateway.call(chief, { name: "shell", arguments: {} })).ok, false);
    const invalid = await gateway.call(chief, { name: "aihub_list_activity", arguments: { limit: 500 } });
    assert.equal(invalid.ok, false);
    assert.match(invalid.text, /Invalid arguments for aihub_list_activity/);
    const extra = await gateway.call(chief, { name: "aihub_get_roster", arguments: { all: true } });
    assert.equal(extra.ok, false);
  });

  it("stores one report per run", async () => {
    const { gateway, supervisor, store } = office();
    const report = { summary: "Planning moved to 10:00.", items: [{ title: "Clash", detail: "Overlaps the review.", urgency: "today", needsOperator: true, sourceRef: "evt-1" }] };

    assert.deepEqual(await gateway.call(supervisor, { name: "aihub_submit_report", arguments: report }), { ok: true, text: "Report filed." });
    const again = await gateway.call(supervisor, { name: "aihub_submit_report", arguments: report });

    assert.equal(again.ok, false);
    assert.match(again.text, /already filed/);
    assert.deepEqual(store.resultForRun(supervisor.runId)?.body, { ...report, decisionsNeeded: [], noLongerApplies: [] });
  });

  it("applies argument defaults", async () => {
    const { gateway, chief } = office();
    await gateway.call(chief, { name: "aihub_get_roster", arguments: {} });

    const outcome = await gateway.call(chief, { name: "aihub_list_activity", arguments: null });

    assert.equal(outcome.ok, true);
    assert.equal(JSON.parse(outcome.text)[0].what, "Used aihub_get_roster");
  });
});
