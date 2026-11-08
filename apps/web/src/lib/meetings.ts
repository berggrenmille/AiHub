// How a meeting reads on screen (DESIGN.md › Meetings): where it stands, who has the floor, and
// what waits for the operator. Pure functions over records, so they can be tested on their own.

import { MEETING_ROUNDS, type Meeting, type MeetingOutcome } from "@aihub/shared";

export type MeetingStatus = "live" | "needs_you" | "paused" | "ended";

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  live: "Live",
  needs_you: "Needs you",
  paused: "Paused",
  ended: "Ended",
};

/** The conclusion waiting for the operator, if there is one. */
export function proposedOutcome(meeting: Meeting): MeetingOutcome | null {
  return meeting.outcomes.findLast((outcome) => outcome.status === "proposed") ?? null;
}

/**
 * Live while turns run; Needs you once a conclusion waits; Paused when it waits with none, such as
 * when the turn budget stopped it or the chair's turn failed.
 */
export function meetingStatus(meeting: Meeting): MeetingStatus {
  if (meeting.state === "closed") return "ended";
  if (meeting.state === "running") return "live";
  return proposedOutcome(meeting) ? "needs_you" : "paused";
}

/** The meeting under way, if any. Only one runs at a time. */
export function runningMeeting(meetings: Meeting[]): Meeting | null {
  return meetings.find((meeting) => meeting.state === "running") ?? null;
}

/** Who has the floor in a meeting that is under way, as a line for its header. */
export function floorLine(meeting: Meeting, nameOf: (agentId: string) => string): string {
  const round = `Round ${meeting.round} of at most ${MEETING_ROUNDS}`;
  switch (meetingStatus(meeting)) {
    case "live": {
      const next = meeting.queue[0];
      if (!next) return round;
      return next === meeting.chairId ? `${round} · ${nameOf(next)} is wrapping up the round` : `${round} · ${nameOf(next)} has the floor`;
    }
    case "needs_you":
      return "The conclusion waits for you. Approve it, or reply to change it.";
    case "paused":
      return "Paused. Say something in the meeting to carry on, or end it.";
    case "ended":
      return meeting.outcomes.some((outcome) => outcome.status === "approved") ? "Ended with the conclusion you approved." : "Ended without a conclusion.";
  }
}

/** The most turns a meeting with this many supervisors can take: each speaks and the chair answers, every round. */
export function meetingTurns(supervisors: number): { first: number; most: number } {
  return { first: supervisors + 1, most: (supervisors + 1) * MEETING_ROUNDS };
}
