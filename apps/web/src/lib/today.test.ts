import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BriefingItem, BriefingSectionRecord, ChatMessage, Item, Meeting, Proposal, Service } from "@aihub/shared";
import { briefingAsks, decisionsWaiting, needsLine, sectionAsks, sectionsInOrder, toldState } from "./today.ts";

function item(id: number, overrides: Partial<Item> = {}): Item {
  return {
    id,
    responsibilityId: "schedule",
    sourceKey: `key-${id}`,
    title: `Item ${id}`,
    detail: "",
    urgency: "today",
    link: null,
    needsOperator: true,
    state: "open",
    firstSeenAt: "2026-11-09T06:00:00.000Z",
    lastReportedAt: null,
    resolution: null,
    updatedAt: "2026-11-09T06:00:00.000Z",
    ...overrides,
  };
}

function told(id: number | null, overrides: Partial<BriefingItem> = {}): BriefingItem {
  return { id, title: `Item ${id}`, detail: "", urgency: "today", needsOperator: true, link: null, resolution: null, ...overrides };
}

function section(agentId: string, overrides: Partial<BriefingSectionRecord> = {}): BriefingSectionRecord {
  return {
    agentId,
    heading: agentId,
    source: "Work calendar",
    responsibilityId: agentId,
    status: "reported",
    summary: "Checked.",
    decisions: [],
    reason: null,
    warning: null,
    runId: null,
    fresh: [],
    carried: [],
    resolved: [],
    ...overrides,
  };
}

const byId = (...items: Item[]) => new Map(items.map((entry) => [entry.id, entry]));

describe("Today", () => {
  it("tells where each item a briefing told stands now", () => {
    const items = byId(item(1), item(2, { state: "resolved" }), item(3, { state: "dismissed" }), item(4, { needsOperator: false }));
    assert.equal(toldState(told(1), items), "waiting");
    assert.equal(toldState(told(2), items), "resolved");
    assert.equal(toldState(told(3), items), "dismissed");
    assert.equal(toldState(told(4, { needsOperator: false }), items), "known");
    // An item no longer loaded, or never kept, goes by what the briefing said.
    assert.equal(toldState(told(99), items), "waiting");
    assert.equal(toldState(told(null, { needsOperator: false }), items), "known");
  });

  it("counts what a section still asks, and puts asking sections first", () => {
    const items = byId(item(1), item(2, { state: "resolved" }), item(3));
    const quiet = section("news", { status: "nothing_new" });
    const asking = section("schedule", { fresh: [told(1), told(2)], carried: [told(3)], decisions: ["Move the review?"] });
    const missing = section("mail", { status: "missing", reason: "The run failed" });
    assert.equal(sectionAsks(asking, items), 3);
    assert.equal(sectionAsks(quiet, items), 0);
    assert.deepEqual(sectionsInOrder([quiet, asking, missing], items).map((entry) => entry.agentId), ["schedule", "mail", "news"]);
    assert.equal(briefingAsks({ id: "b", messageId: 1, deliveredAt: "", overview: "", sourceData: true, sections: [quiet, asking, missing] }, items), 3);
  });

  it("lists every decision waiting for the operator, oldest first, with the chat its card is in", () => {
    const meeting = (id: string, state: Meeting["state"], proposed: boolean): Meeting => ({
      id,
      title: "Plan the week",
      agenda: "Plan the week",
      calledBy: "operator",
      chairId: "chief",
      participantIds: [],
      state,
      round: 1,
      queue: [],
      outcomes: proposed ? [{ id: 1, summary: "", decisions: [], tasks: [], fromSourceData: false, status: "proposed", createdAt: "", decidedAt: null }] : [],
      createdAt: "2026-11-09T08:00:00.000Z",
      endedAt: null,
    });
    const proposal = {
      id: "p-1",
      kind: "recruit_supervisor",
      proposedBy: "chief",
      payload: { profile: { name: "Nora", title: "News Supervisor" } },
      status: "pending",
      outcome: null,
      createdAt: "2026-11-09T07:00:00.000Z",
      decidedAt: null,
    } as unknown as Proposal;
    const service = { id: "s-1", name: "Fake mail", status: "proposed", createdAt: "2026-11-09T09:00:00.000Z" } as Service;
    const card = (id: number, kind: ChatMessage["kind"], refId: string): ChatMessage => ({
      id,
      conversationId: "topic-1",
      author: "agent",
      agentId: "chief",
      kind,
      body: "",
      runId: null,
      refId,
      createdAt: "",
    });
    const decisions = decisionsWaiting({
      meetings: [meeting("meeting-1", "waiting", true), meeting("meeting-2", "running", false)],
      proposals: [proposal, { ...proposal, id: "p-2", status: "approved" }],
      staffChanges: [],
      policies: [],
      services: [service],
      messages: { "topic-1": [card(1, "proposal", "p-1")] },
    });
    assert.deepEqual(
      decisions.map((decision) => [decision.kind, decision.title, decision.conversationId]),
      [
        ["proposal", "Hire Nora, News Supervisor", "topic-1"],
        ["meeting", 'Approve the conclusion of "Plan the week"', "meeting-1"],
        ["service", "Connect Fake mail", null],
      ],
    );
  });

  it("says how much needs the operator", () => {
    assert.equal(needsLine(0), "Nothing needs you right now.");
    assert.equal(needsLine(1), "1 thing needs you.");
    assert.equal(needsLine(3), "3 things need you.");
  });
});
