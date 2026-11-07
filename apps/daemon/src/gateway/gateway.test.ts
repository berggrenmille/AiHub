import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Store } from "../store/store.ts";
import { Gateway, type Caller } from "./gateway.ts";
import { OFFICE_TOOLS } from "./tools.ts";

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

    assert.deepEqual(gateway.specsFor(chief).map((tool) => tool.name), ["aihub_get_roster", "aihub_list_activity"]);
    assert.deepEqual(gateway.specsFor({ ...chief, profile: "data" }), []);
    assert.deepEqual(gateway.specsFor(supervisor).map((tool) => tool.name), ["aihub_submit_report"]);
    assert.deepEqual(gateway.specsFor({ ...supervisor, profile: "conversation" }), []);
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
    const { gateway, chief, store } = office();

    const outcome = await gateway.call(chief, { name: "aihub_get_roster", arguments: {} });

    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(outcome.text), [
      { name: "Chief of Staff", role: "chief_of_staff", manager: null, state: "queued" },
      { name: "Work Schedule", role: "supervisor", manager: "Chief of Staff", state: "queued" },
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
    const report = { summary: "Planning moved to 10:00.", items: [{ title: "Clash", detail: "Overlaps the review.", urgency: "today", sourceRef: "evt-1" }] };

    assert.deepEqual(await gateway.call(supervisor, { name: "aihub_submit_report", arguments: report }), { ok: true, text: "Report filed." });
    const again = await gateway.call(supervisor, { name: "aihub_submit_report", arguments: report });

    assert.equal(again.ok, false);
    assert.match(again.text, /already filed/);
    assert.deepEqual(store.resultForRun(supervisor.runId)?.body, { ...report, decisionsNeeded: [] });
  });

  it("applies argument defaults", async () => {
    const { gateway, chief } = office();
    await gateway.call(chief, { name: "aihub_get_roster", arguments: {} });

    const outcome = await gateway.call(chief, { name: "aihub_list_activity", arguments: null });

    assert.equal(outcome.ok, true);
    assert.equal(JSON.parse(outcome.text)[0].what, "Used aihub_get_roster");
  });
});
