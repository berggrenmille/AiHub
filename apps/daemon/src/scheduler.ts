import type { Routine } from "@aihub/shared";
import { runBriefing } from "./briefing/briefing.ts";
import { collectSections } from "./briefing/morning.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { DAILY_TURN_LIMIT } from "./limits.ts";
import type { Office } from "./office.ts";
import { verifyConnection } from "./sources/collect.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import { addDays, isWeekday, localDate, zonedInstant } from "./time.ts";

// The scheduler (DESIGN.md › Scheduling and reporting). Each weekday routine has one occurrence a
// day, recorded before it runs, so retries and restarts never deliver twice. A missed briefing is
// caught up later the same day; earlier missed days are skipped, and the next briefing still covers
// everything, since collectors report all changes since their cursor. A health check an hour before
// tells the operator in time to fix what would spoil the briefing.

const HEALTH_LEAD_MS = 60 * 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const MAX_ATTEMPTS = 2;
/** Above this share of the plan's usage window, the health check warns. */
const USAGE_WARNING_PERCENT = 90;

export interface SchedulerOptions {
  now?: () => Date;
  tickMs?: number;
  /** Runs the briefing, or returns null when nobody reports to it yet. Tests replace it. */
  briefing?: (office: Office) => Promise<{ run: { id: string; state: string; error: string | null } } | null>;
}

export class Scheduler {
  private readonly now: () => Date;
  private readonly briefing: NonNullable<SchedulerOptions["briefing"]>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private ticking = false;

  constructor(
    private readonly office: Office,
    private readonly options: SchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.briefing =
      options.briefing ??
      ((office) => {
        const sections = collectSections(office, this.now());
        return sections.length ? runBriefing(office, sections, { now: this.now() }) : Promise.resolve(null);
      });
  }

  /** Closes out occurrences a restart interrupted, then checks the clock regularly. */
  start() {
    this.office.store.failRunningOccurrences("The daemon stopped during this run.");
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waits for a briefing in progress, for tests and shutdown. */
  async idle() {
    await this.running;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const routine of this.office.store.listRoutines()) {
        if (routine.paused || routine.trigger.type !== "weekdays") continue;
        const today = localDate(now, routine.timezone);
        if (!isWeekday(today)) continue;
        const due = zonedInstant(today, routine.trigger.time, routine.timezone);
        if (now >= new Date(due.getTime() - HEALTH_LEAD_MS) && now < due) await this.healthCheck(routine, today);
        if (now >= due) this.runOccurrence(routine, `${routine.id}:${today}`, due);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Runs the briefing now, outside the schedule. */
  runNow(routineId: string): string {
    const routine = this.office.store.getRoutine(routineId);
    if (!routine) throw new NotFoundError(`No routine ${routineId}`);
    if (this.running) throw new ConflictError("A briefing is already running.");
    const now = this.now();
    const id = `${routine.id}:manual:${now.toISOString()}`;
    this.runOccurrence(routine, id, now);
    return id;
  }

  /** The next time a routine runs on its own, for the UI. */
  nextRunAt(routine: Routine): string | null {
    if (routine.paused || routine.trigger.type !== "weekdays") return null;
    const now = this.now();
    let day = localDate(now, routine.timezone);
    for (let n = 0; n < 8; n++, day = addDays(day, 1)) {
      if (!isWeekday(day)) continue;
      const at = zonedInstant(day, routine.trigger.time, routine.timezone);
      const claimed = this.office.store.getOccurrence(`${routine.id}:${day}`);
      if (at > now || (!claimed && n === 0)) return at.toISOString();
    }
    return null;
  }

  private runOccurrence(routine: Routine, id: string, scheduledFor: Date) {
    const { store } = this.office;
    if (this.running) return;
    if (!store.claimOccurrence(id, routine.id, scheduledFor.toISOString())) {
      // Already recorded: retry a failed one once, after a pause.
      const occurrence = store.getOccurrence(id)!;
      const retryDue = Date.parse(occurrence.updatedAt) <= this.now().getTime() - RETRY_AFTER_MS;
      if (occurrence.status !== "failed" || occurrence.attempts >= MAX_ATTEMPTS || !retryDue) return;
    }
    store.updateOccurrence(id, { status: "running", attempt: true });
    this.running = this.briefing(this.office)
      .then((outcome) => {
        if (!outcome) return store.updateOccurrence(id, { status: "skipped", detail: "Nobody reports to the briefing yet." });
        const { run } = outcome;
        if (run.state === "done") store.updateOccurrence(id, { status: "delivered", runId: run.id });
        else store.updateOccurrence(id, { status: "failed", runId: run.id, detail: run.error ?? "The briefing failed." });
      })
      .catch((error: unknown) => store.updateOccurrence(id, { status: "failed", detail: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        this.running = null;
        this.office.bus.publish({ type: "office", office: this.office.officeStats() });
      });
  }

  /** Checks sign-in, sources, and usage before the briefing, and says what to fix. */
  private async healthCheck(routine: Routine, today: string) {
    const { store, bus } = this.office;
    if (!store.claimOccurrence(`${routine.id}:${today}:health`, routine.id, this.now().toISOString())) return;
    const problems: string[] = [];
    const runtime = await this.office.refreshRuntimeStatus();
    if (!runtime.signedIn) problems.push(`Codex isn't signed in (${runtime.detail}). Run \`npm run codex -- login\`.`);
    for (const connection of store.listConnections()) {
      const checked = verifyConnection(store, connection.id, this.now());
      bus.publish({ type: "connection", connection: checked });
      if (checked.status !== "connected") problems.push(`${checked.label}: ${checked.detail}`);
    }
    const usage = await this.office.usageLimits().catch(() => null);
    if (usage && usage.usedPercent >= USAGE_WARNING_PERCENT) {
      problems.push(`The Codex plan's usage window is ${usage.usedPercent}% used, so the briefing may not finish.`);
    }
    if (this.office.officeStats().turnsToday >= DAILY_TURN_LIMIT) problems.push("Today's turn budget is already used up.");
    store.updateOccurrence(`${routine.id}:${today}:health`, { status: "delivered", detail: problems.join("\n") || null });

    const summary = problems.length ? `Health check: ${problems.length} problem${problems.length === 1 ? "" : "s"} before the briefing` : "Health check passed";
    bus.publish({ type: "activity", entry: store.addActivity({ agentId: CHIEF_OF_STAFF_ID, runId: null, kind: "health", summary }) });
    if (problems.length) {
      this.office.postMessage(
        CHIEF_OF_STAFF_CONVERSATION_ID,
        CHIEF_OF_STAFF_ID,
        `Before ${routine.trigger.type === "weekdays" ? routine.trigger.time : "the briefing"}, a few things need you:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
        null,
        "notice",
      );
    }
  }
}
