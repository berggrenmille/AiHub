import type { ActivityKind, AgentRole, AssignmentKind, AssignmentStatus, RoutineTrigger, RunKind, RunState, SourceConnection, Urgency } from "@aihub/shared";

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
  proposal: "waiting",
  approved: "done",
  declined: "idle",
  collected: "working",
  item: "working",
  responsibility_ended: "done",
  briefing: "done",
  health: "failed",
  assignment: "working",
  worker: "waiting",
  web: "idle",
  policy: "waiting",
  model: "idle",
  view: "done",
  review: "done",
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

const longDateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "numeric", month: "short" });

/** A long date for the morning paper's masthead, such as Saturday 7 November 2026. */
export function formatLongDate(iso: string): string {
  return longDateFormat.format(new Date(iso));
}

/** The time for today, otherwise the day and month, such as 7 Nov. */
export function formatShortWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  return dayFormat.format(date) === dayFormat.format(now) ? shortTimeFormat.format(date) : shortDateFormat.format(date);
}

/** How long ago, roughly: "just now", "4 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export const URGENCY_LABELS: Record<Urgency, string> = {
  urgent: "Urgent",
  today: "Today",
  this_week: "This week",
  fyi: "FYI",
};

export function triggerLabel(trigger: RoutineTrigger): string {
  if (trigger.type === "weekdays") return `Weekdays at ${trigger.time}`;
  if (trigger.type === "daily") return `Every day at ${trigger.time}`;
  return "Part of the morning briefing";
}

export const CONNECTION_STATUS_LABELS: Record<SourceConnection["status"], string> = {
  connected: "Connected",
  unverified: "Not verified",
  failed: "Failed",
};

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  open: "Open",
  waiting: "Waiting on team",
  delivered: "Delivered",
  accepted: "Accepted",
  failed: "Failed",
};

const ASSIGNMENT_TONES: Record<AssignmentStatus, Tone> = {
  open: "working",
  waiting: "waiting",
  delivered: "done",
  accepted: "done",
  failed: "failed",
};

export function assignmentTone(status: AssignmentStatus): Tone {
  return ASSIGNMENT_TONES[status];
}

export const ASSIGNMENT_KIND_LABELS: Record<AssignmentKind, string> = {
  question: "Question",
  task: "Task",
};

/**
 * Who did it and what, for one activity line. Summaries that already start with the name, such as
 * "Nora joined as Calendar Supervisor", don't get it twice.
 */
export function activityLine(name: string, summary: string): { who: string | null; text: string } {
  return summary.startsWith(`${name} `) ? { who: null, text: summary } : { who: name, text: summary };
}

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  chat: "Chat",
  briefing: "Briefing",
  report: "Report",
  question: "Question",
  assignment: "Task",
  follow_up: "Follow-up",
  review: "Staff review",
};
