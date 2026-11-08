import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PolicyVersion } from "@aihub/shared";
import { baseOf, currentPolicy, diffLines, pendingPolicy } from "./policy.ts";

function version(id: number, overrides: Partial<PolicyVersion> = {}): PolicyVersion {
  return {
    id,
    body: `- Rule ${id}`,
    authorId: null,
    reason: null,
    basedOn: null,
    status: "approved",
    fromSourceData: false,
    outcome: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    decidedAt: `2026-11-08T10:0${id}:00.000Z`,
    ...overrides,
  };
}

describe("The office policy", () => {
  it("finds the current version and the proposal waiting", () => {
    // A proposal made before a later edit was approved last, so approval time decides.
    const policies = [version(3, { status: "pending", decidedAt: null, basedOn: 2 }), version(2, { decidedAt: "2026-11-08T09:00:00.000Z" }), version(1)];
    assert.equal(currentPolicy(policies)?.id, 1);
    assert.equal(pendingPolicy(policies)?.id, 3);
    assert.equal(currentPolicy([]), null);
    assert.equal(baseOf(policies[0]!, policies), "- Rule 2");
    assert.equal(baseOf(version(4, { basedOn: null }), policies), "");
    assert.equal(baseOf(version(5, { basedOn: 99 }), policies), null);
  });

  it("shows what a proposal changes, line by line", () => {
    assert.deepEqual(diffLines("- English.\n- Brief.", "- English.\n- Flag money.\n- Brief, always."), [
      { kind: "same", text: "- English." },
      { kind: "removed", text: "- Brief." },
      { kind: "added", text: "- Flag money." },
      { kind: "added", text: "- Brief, always." },
    ]);
    assert.deepEqual(diffLines("", "- One."), [{ kind: "added", text: "- One." }]);
    assert.deepEqual(diffLines("- One.", ""), [{ kind: "removed", text: "- One." }]);
  });
});
