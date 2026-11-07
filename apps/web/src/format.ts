import type { ActivityKind, AgentRole, RunState } from "@aihub/shared";

export type AgentState = RunState | "idle";

/** The badge styles. Run states that look alike to the operator share one. */
export type Tone = "idle" | "queued" | "working" | "waiting" | "done" | "failed";

export const STATE_LABELS: Record<AgentState, string> = {
  idle: "Idle",
  queued: "Queued",
  collecting: "Collecting",
  working: "Working",
  reviewing: "Reviewing",
  waiting_for_access: "Waiting for access",
  waiting_for_approval: "Waiting for approval",
  done: "Done",
  failed: "Failed",
};

const STATE_TONES: Record<AgentState, Tone> = {
  idle: "idle",
  queued: "queued",
  collecting: "working",
  working: "working",
  reviewing: "working",
  waiting_for_access: "waiting",
  waiting_for_approval: "waiting",
  done: "done",
  failed: "failed",
};

export function toneOf(state: AgentState): Tone {
  return STATE_TONES[state];
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  chief_of_staff: "Chief of Staff",
  supervisor: "Supervisor",
  worker: "Worker",
};

const ACTIVITY_TONES: Record<ActivityKind, Tone> = {
  run_queued: "queued",
  run_started: "working",
  run_finished: "done",
  run_failed: "failed",
  tool_call: "idle",
  tool_refused: "failed",
  blocked: "failed",
  context_rebuilt: "idle",
};

export function activityTone(kind: ActivityKind): Tone {
  return ACTIVITY_TONES[kind];
}

// Times are shown in AiHub's timezone, wherever the browser is (DESIGN.md › Scheduling and reporting).
const TIME_ZONE = "Europe/Stockholm";
const dayFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, dateStyle: "short" });
const timeFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, timeStyle: "medium" });
const shortTimeFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, timeStyle: "short" });

/** Full date and time, such as 2026-11-07 17:36:12. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${dayFormat.format(date)} ${timeFormat.format(date)}`;
}

/** The time alone for today, with the date for earlier days. */
export function formatFeedTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  return dayFormat.format(date) === dayFormat.format(now) ? timeFormat.format(date) : formatDateTime(iso);
}

/** Hours and minutes, such as 17:36. */
export function formatClock(iso: string): string {
  return shortTimeFormat.format(new Date(iso));
}
