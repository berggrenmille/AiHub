import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProposedOperation, StaffChange, StaffChangeDetail } from "@aihub/shared";
import { grantsNothing, staffChangeTitle } from "./staff-changes.ts";

function change(detail: StaffChangeDetail): StaffChange {
  return {
    id: 1,
    agentId: "ines",
    agentName: "Ines",
    responsibilityId: "r1",
    responsibilityTitle: "Inbox",
    change: detail,
    reason: "You asked for it.",
    proposedBy: "chief",
    runId: null,
    fromSourceData: false,
    status: "pending",
    outcome: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
  };
}

const search: ProposedOperation = { serviceId: "mail", serviceName: "Work mail", operation: "search_messages", why: "To look things up.", unsafe: null };
const send: ProposedOperation = { serviceId: "mail", serviceName: "Work mail", operation: "send_message", why: "To reply.", unsafe: "Ines could send what they know to anyone." };
const sendGrant = { key: "operation:mail/send_message", what: "send_message on Work mail", risk: send.unsafe!, required: false };

describe("staff changes", () => {
  it("names an operations change by what it lets the supervisor call", () => {
    assert.equal(staffChangeTitle(change({ kind: "operations", operations: [send], unsafe: [sendGrant] }), null), "Let Ines call send_message on Work mail");
    assert.equal(staffChangeTitle(change({ kind: "operations", operations: [search, send], unsafe: [sendGrant] }), null), "Let Ines call 2 operations on Work mail");
  });

  it("holds approval only when every operation is unsafe and none is ticked", () => {
    const onlySend = change({ kind: "operations", operations: [send], unsafe: [sendGrant] });
    assert.equal(grantsNothing(onlySend, new Set()), true);
    assert.equal(grantsNothing(onlySend, new Set([sendGrant.key])), false);
    assert.equal(grantsNothing(change({ kind: "operations", operations: [search, send], unsafe: [sendGrant] }), new Set()), false, "searching is granted either way");
    assert.equal(grantsNothing(change({ kind: "end" }), new Set()), false);
  });
});
