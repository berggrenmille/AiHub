import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEntry, ActivityKind, RunKind } from "@aihub/shared";
import { toastWorthy } from "./toasts.ts";

function entry(kind: ActivityKind, summary: string, runId: string | null = null): ActivityEntry {
  return { id: 1, agentId: null, runId, kind, summary, at: "2026-11-08T20:00:00.000Z" };
}

const runs: Record<string, RunKind> = { brief: "briefing", talk: "chat" };
const away = { runKind: (id: string) => runs[id], cardsInView: false, meetingInView: false };
const looking = { ...away, cardsInView: true };

describe("Toasts", () => {
  it("pops up only what needs the operator or went wrong", () => {
    assert.equal(toastWorthy(entry("run_failed", "Reply in chat: failed"), away), true);
    assert.equal(toastWorthy(entry("blocked", "Blocked an attempt to write a file"), away), true);
    assert.equal(toastWorthy(entry("proposal", "Proposed hiring Ines"), away), true);
    assert.equal(toastWorthy(entry("service", "Proposed adding GitHub"), away), true);
    assert.equal(toastWorthy(entry("policy", "Proposed a change to the office policy"), away), true);
    assert.equal(toastWorthy(entry("health", "Health check: 1 problem before the briefing"), away), true);
    assert.equal(toastWorthy(entry("run_finished", "Morning briefing: done", "brief"), away), true);
    assert.equal(toastWorthy(entry("meeting", 'Proposed the conclusion of the meeting "Plan the week"'), away), true);

    assert.equal(toastWorthy(entry("run_finished", "Reply in chat: done", "talk"), away), false);
    assert.equal(toastWorthy(entry("run_finished", "Answer: done", "gone"), away), false, "a run the app doesn't know");
    assert.equal(toastWorthy(entry("assignment", 'Vera asked Nora: "How are you?"'), away), false);
    assert.equal(toastWorthy(entry("service", "Unsafe: Elias called add_reaction on GitHub"), away), false);
    assert.equal(toastWorthy(entry("policy", "The operator approved the new office policy"), away), false);
    assert.equal(toastWorthy(entry("health", "Health check passed"), away), false);
    assert.equal(toastWorthy(entry("item", 'Left out "A PR": it cites no collected record'), away), false);
    assert.equal(toastWorthy(entry("meeting", 'The operator called a meeting: "Plan the week"'), away), false);
  });

  it("leaves out a new card when a chat it lands in is on screen", () => {
    assert.equal(toastWorthy(entry("proposal", "Proposed hiring Ines"), looking), false);
    assert.equal(toastWorthy(entry("service", "Proposed adding GitHub"), looking), false);
    assert.equal(toastWorthy(entry("run_failed", "Reply in chat: failed"), looking), true);
    const inMeeting = { ...away, meetingInView: true };
    assert.equal(toastWorthy(entry("meeting", 'Proposed the conclusion of the meeting "Plan the week"'), inMeeting), false);
  });
});
