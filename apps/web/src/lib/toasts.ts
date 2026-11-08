// Which activity pops up as a toast. Only what needs the operator or went wrong does: everything else
// stays in the activity strip, so a busy office doesn't bury the screen.

import type { ActivityEntry, RunKind } from "@aihub/shared";

export interface ToastContext {
  /** The kind of a run the web app knows. */
  runKind(runId: string): RunKind | undefined;
  /** A Chief of Staff's chat is on screen, where approval cards land, so a new card is already in view. */
  cardsInView: boolean;
  /** A meeting is on screen, where its conclusion lands. */
  meetingInView: boolean;
}

export function toastWorthy(entry: ActivityEntry, context: ToastContext): boolean {
  switch (entry.kind) {
    case "run_failed":
    case "blocked":
      return true;
    // A card waits for the operator: hiring, a staff change, a policy, or a service.
    case "proposal":
      return !context.cardsInView;
    case "policy":
    case "service":
      return entry.summary.startsWith("Proposed") && !context.cardsInView;
    // A meeting's conclusion waits for the operator.
    case "meeting":
      return entry.summary.startsWith("Proposed") && !context.meetingInView;
    // The check before the briefing, when it found something wrong.
    case "health":
      return entry.summary.startsWith("Health check:");
    // The briefing is in.
    case "run_finished":
      return entry.runId !== null && context.runKind(entry.runId) === "briefing";
    default:
      return false;
  }
}

/** At most this many toasts show at once; a burst beyond them folds into one line. */
export const MAX_TOASTS = 2;
