import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Meeting, MeetingOutcome } from "@aihub/shared";
import { floorLine, meetingStatus, meetingTurns, proposedOutcome, runningMeeting } from "./meetings.ts";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    title: "Plan the week",
    agenda: "Plan the week",
    calledBy: "operator",
    chairId: "chief",
    participantIds: ["nora", "elin"],
    state: "running",
    round: 1,
    queue: ["nora", "elin", "chief"],
    outcomes: [],
    createdAt: "2026-11-08T09:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function outcome(id: number, status: MeetingOutcome["status"]): MeetingOutcome {
  return { id, summary: "Move the review.", decisions: [], tasks: [], fromSourceData: false, status, createdAt: "2026-11-08T09:10:00.000Z", decidedAt: null };
}

const names: Record<string, string> = { chief: "Vera", nora: "Nora", elin: "Elin" };
const nameOf = (id: string) => names[id] ?? id;

describe("Meetings", () => {
  it("reads as live, waiting for the operator, paused or ended", () => {
    assert.equal(meetingStatus(meeting()), "live");
    assert.equal(meetingStatus(meeting({ state: "waiting", queue: [], outcomes: [outcome(1, "superseded"), outcome(2, "proposed")] })), "needs_you");
    assert.equal(meetingStatus(meeting({ state: "waiting", queue: ["elin", "chief"] })), "paused", "the turn budget stopped it");
    assert.equal(meetingStatus(meeting({ state: "closed", queue: [] })), "ended");
    assert.equal(proposedOutcome(meeting({ outcomes: [outcome(1, "superseded"), outcome(2, "proposed")] }))?.id, 2);
  });

  it("says who has the floor", () => {
    assert.equal(floorLine(meeting(), nameOf), "Round 1 of at most 3 · Nora has the floor");
    assert.equal(floorLine(meeting({ round: 2, queue: ["chief"] }), nameOf), "Round 2 of at most 3 · Vera is wrapping up the round");
    assert.equal(floorLine(meeting({ state: "closed", queue: [], outcomes: [outcome(1, "approved")] }), nameOf), "Ended with the conclusion you approved.");
    assert.equal(floorLine(meeting({ state: "closed", queue: [] }), nameOf), "Ended without a conclusion.");
  });

  it("finds the one under way, and counts what a meeting can cost", () => {
    assert.equal(runningMeeting([meeting({ id: "a", state: "closed" }), meeting({ id: "b" })])?.id, "b");
    assert.equal(runningMeeting([meeting({ state: "waiting" })]), null);
    assert.deepEqual(meetingTurns(4), { first: 5, most: 15 });
  });
});
