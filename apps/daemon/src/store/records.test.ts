import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Store } from "./store.ts";

// Milestone 2 records: profiles, responsibilities, sources, proposals, occurrences, and items.

const chief = { id: "chief", name: "Vera", title: "Chief of Staff", role: "chief_of_staff", managerId: null, profile: "conversation", charter: "" } as const;
const schedule = { id: "schedule", name: "Elin", title: "Work Schedule Supervisor", role: "supervisor", managerId: "chief", profile: "data", charter: "" } as const;

function setup(start = "2026-11-09T06:00:00.000Z") {
  let now = new Date(start);
  const store = new Store(":memory:", () => now);
  store.upsertAgent(chief);
  store.upsertAgent(schedule);
  const responsibility = store.createResponsibility({
    ownerId: "schedule",
    title: "Work schedule",
    scope: "The work calendar",
    standingInstructions: "",
    expiresAt: null,
  });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  return { store, responsibility, at };
}

const record = (version: string) => ({
  sourceKey: "evt-1",
  sourceVersion: version,
  title: "Q4 planning moved",
  detail: "Now 10:00",
  urgency: "today" as const,
  expiresAt: null,
});

describe("Store records", () => {
  it("keeps the operator's profile edits when the code updates an agent", () => {
    const { store } = setup();
    store.updateProfile("schedule", { name: "Elsa", workingStyle: "Terse." });
    store.upsertAgent({ ...schedule, charter: "New charter" });
    const agent = store.getAgentRecord("schedule")!;
    assert.equal(agent.name, "Elsa");
    assert.equal(agent.title, "Work Schedule Supervisor");
    assert.equal(agent.workingStyle, "Terse.");
    assert.equal(agent.charter, "New charter");
  });

  it("gives new staff readable IDs and refuses duplicate names", () => {
    const { store } = setup();
    assert.equal(store.freeAgentId("Work Schedule"), "work-schedule");
    assert.equal(store.freeAgentId("Schedule"), "schedule-2");
    assert.equal(store.isNameTaken("elin"), true);
    assert.equal(store.isNameTaken("Elin", "schedule"), false);
  });

  it("shows staff waiting for access, and done once their responsibility ends", () => {
    const { store, responsibility } = setup();
    const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path: "C:/cal.ics" });
    store.grant("schedule", connection.id, ["read"]);
    assert.equal(store.getAgent("schedule")!.state, "waiting_for_access");

    store.setConnectionStatus(connection.id, "connected", "12 events");
    assert.equal(store.getAgent("schedule")!.state, "idle");

    store.endResponsibility(responsibility.id);
    assert.equal(store.getAgent("schedule")!.state, "done");
  });

  it("ends a mandate at its expiry", () => {
    const { store, at } = setup();
    const mandate = store.createResponsibility({
      ownerId: "chief",
      title: "Review meeting load",
      scope: "Two weeks",
      standingInstructions: "",
      expiresAt: "2026-11-23T06:00:00.000Z",
    });
    assert.equal(store.isResponsibilityActive(mandate.id), true);
    at("2026-11-23T06:00:00.000Z");
    assert.equal(store.isResponsibilityActive(mandate.id), false);
    assert.deepEqual(store.endExpiredResponsibilities().map((ended) => ended.id), [mandate.id]);
    assert.equal(store.endResponsibility(mandate.id), null);
  });

  it("decides a proposal once", () => {
    const { store } = setup();
    const proposal = store.createProposal({
      proposedBy: "chief",
      runId: null,
      payload: {
        profile: { name: "Saga", title: "Personal Inbox Supervisor", description: "", workingStyle: "" },
        responsibility: { title: "Personal inbox", scope: "", standingInstructions: "", expiresAt: null },
        source: null,
        reason: "Asked in chat",
      },
    });
    assert.equal(store.listProposals()[0]!.status, "pending");
    assert.equal(store.decideProposal(proposal.id, "approved", "Hired Saga")?.status, "approved");
    assert.equal(store.decideProposal(proposal.id, "declined", "Too late"), null);
  });

  it("claims each occurrence once", () => {
    const { store } = setup();
    const routine = store.createRoutine({
      ownerId: "chief",
      responsibilityId: null,
      title: "Morning briefing",
      trigger: { type: "weekdays", time: "07:00" },
      timezone: "Europe/Stockholm",
      dailyTurnBudget: 10,
    });
    assert.equal(store.claimOccurrence(`${routine.id}:2026-11-09`, routine.id, "2026-11-09T06:00:00.000Z"), true);
    assert.equal(store.claimOccurrence(`${routine.id}:2026-11-09`, routine.id, "2026-11-09T06:00:00.000Z"), false);
    assert.equal(store.startOccurrence(store.getOccurrence(`${routine.id}:2026-11-09`)!), true);
    assert.equal(store.failRunningOccurrences("Restarted", 15 * 60_000, 2), 1);
    const failed = store.getOccurrence(`${routine.id}:2026-11-09`)!;
    assert.deepEqual([failed.status, failed.attempts, failed.retryAt !== null], ["failed", 1, true]);
  });

  it("never reports an unchanged item as new twice", () => {
    const { store, responsibility } = setup();
    const first = store.upsertItem({ responsibilityId: responsibility.id, ...record("v1") });
    assert.equal(first.change, "new");
    store.markReported([first.item.id]);

    const again = store.upsertItem({ responsibilityId: responsibility.id, ...record("v1") });
    assert.equal(again.change, "unchanged");
    assert.equal(again.item.state, "open");

    const changed = store.upsertItem({ responsibilityId: responsibility.id, ...record("v2"), detail: "Now 11:00" });
    assert.equal(changed.change, "changed");
    assert.equal(changed.item.state, "new");
    assert.equal(changed.item.detail, "Now 11:00");
  });

  it("keeps a dismissed item out until its source changes", () => {
    const { store, responsibility } = setup();
    const { item } = store.upsertItem({ responsibilityId: responsibility.id, ...record("v1") });
    assert.equal(store.closeItem(item.id, "dismissed", null)?.state, "dismissed");
    assert.equal(store.closeItem(item.id, "resolved", "twice"), null);

    assert.equal(store.upsertItem({ responsibilityId: responsibility.id, ...record("v1") }).item.state, "dismissed");
    assert.equal(store.upsertItem({ responsibilityId: responsibility.id, ...record("v2") }).item.state, "new");
  });

  it("resolves items whose source stopped mattering", () => {
    const { store, responsibility, at } = setup();
    store.upsertItem({ responsibilityId: responsibility.id, ...record("v1"), expiresAt: "2026-11-09T10:00:00.000Z" });
    assert.equal(store.resolveExpiredItems("The event is over").length, 0);
    at("2026-11-09T10:00:00.000Z");
    const [resolved] = store.resolveExpiredItems("The event is over");
    assert.equal(resolved?.state, "resolved");
    assert.equal(resolved?.resolution, "The event is over");
    assert.equal(store.closedItemsSince(responsibility.id, "2026-11-09T06:00:00.000Z").length, 1);
  });

  it("counts delivered results and resolved items as experience", () => {
    const { store, responsibility } = setup();
    const run = store.createRun({ agentId: "schedule", kind: "report", title: "Report", responsibilityId: responsibility.id });
    store.addResult({ runId: run.id, agentId: "schedule", summary: "Filed", body: {} });
    const { item } = store.upsertItem({ responsibilityId: responsibility.id, ...record("v1") });
    store.closeItem(item.id, "resolved", "Handled");
    assert.equal(store.getAgent("schedule")!.experience, 2);
    assert.equal(store.getRun(run.id)!.responsibilityId, responsibility.id);
  });

  it("stores a message's kind and the record it refers to", () => {
    const { store } = setup();
    store.ensureConversation({ id: "chief", agentId: "chief", title: "Vera" });
    store.addMessage({ conversationId: "chief", author: "agent", agentId: "chief", body: "Proposal", runId: null, kind: "proposal", refId: "p-1" });
    const [message] = store.recentMessages(5, "chief");
    assert.equal(message?.kind, "proposal");
    assert.equal(message?.refId, "p-1");
  });
});
