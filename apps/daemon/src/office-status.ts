import type { Office } from "./office.ts";
import { clock } from "./scheduler.ts";
import { CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import { addDays, localDate } from "./time.ts";

// The office in a few short lines, for places outside the browser such as the notification-area
// icon on Windows. Like notifications, it says states and counts, never what a source holds: it can
// show on a locked screen or over someone's shoulder.

export interface OfficeStatus {
  /** What the briefing does next, such as "Next briefing Monday at 07:00". */
  status: string;
  /** What needs the operator, one short line each. */
  needs: string[];
  /** Something the operator should look at soon: Codex can't run, a briefing waits, or an approval or urgent item is open. */
  attention: boolean;
}

export function officeStatus(office: Office, now = new Date()): OfficeStatus {
  const { store } = office;
  const needs: string[] = [];
  let attention = false;

  const codex = office.codexStatus;
  if (codex && !codex.signedIn) {
    needs.push(codex.detail.startsWith("Codex is unavailable") ? "Codex can't be reached" : "Codex isn't signed in");
    attention = true;
  }

  const proposals = store.listProposals().filter((proposal) => proposal.status === "pending").length;
  if (proposals) {
    needs.push(proposals === 1 ? "A proposal to approve" : `${proposals} proposals to approve`);
    attention = true;
  }

  const open = store.listItems().filter((item) => item.state === "new" || item.state === "open");
  const urgent = open.filter((item) => item.urgency === "urgent").length;
  if (open.length) {
    needs.push(`${open.length} item${open.length === 1 ? "" : "s"} in your inbox${urgent ? `, ${urgent} urgent` : ""}`);
    if (urgent) attention = true;
  }

  const briefing = briefingStatus(office, now);
  return { status: briefing.text, needs, attention: attention || briefing.waiting };
}

function briefingStatus(office: Office, now: Date): { text: string; waiting: boolean } {
  const { store, scheduler } = office;
  if (scheduler?.busy) return { text: "Writing your briefing…", waiting: false };
  const routine = store.listRoutines().find((candidate) => candidate.trigger.type === "weekdays" && !candidate.paused);
  if (!routine) return { text: "No briefing scheduled", waiting: false };
  if (!someoneReports(office)) {
    const chief = store.getAgent(CHIEF_OF_STAFF_ID)?.name ?? "the Chief of Staff";
    return { text: `No briefing yet: ask ${chief} to look after something`, waiting: false };
  }

  const timeZone = routine.timezone;
  const today = localDate(now, timeZone);
  const occurrence = store.getOccurrence(`${routine.id}:${today}`);
  if (occurrence?.status === "waiting" && occurrence.retryAt) {
    const reason = occurrence.detail ? `: ${occurrence.detail.replace(/\.$/, "")}` : "";
    return { text: `Briefing waiting${reason}. Next try ${clock(new Date(occurrence.retryAt), timeZone)}`, waiting: true };
  }

  const next = scheduler?.nextRunAt(routine);
  if (!next) return { text: "No briefing scheduled", waiting: false };
  const at = new Date(next);
  // Missed earlier today: it catches up at the scheduler's next check.
  if (at <= now) return { text: "Briefing due now", waiting: false };
  const day = localDate(at, timeZone);
  const name =
    day === today ? "today" : day === addDays(today, 1) ? "tomorrow" : new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone }).format(at);
  return { text: `Next briefing ${name} at ${clock(at, timeZone)}`, waiting: false };
}

/** Whether any responsibility reports to the briefing, the way the briefing collects its sections. */
function someoneReports(office: Office): boolean {
  const { store } = office;
  return store
    .listRoutines()
    .some(
      (routine) =>
        routine.trigger.type === "briefing" &&
        !routine.paused &&
        routine.responsibilityId !== null &&
        store.isResponsibilityActive(routine.responsibilityId) &&
        store.getAgent(routine.ownerId) !== null,
    );
}
