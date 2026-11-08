import type { Routine, RoutineTrigger } from "@aihub/shared";
import { runBriefing, type SectionOutcome } from "./briefing/briefing.ts";
import { collectSections } from "./briefing/morning.ts";
import { ConflictError, InvalidRequestError, NotFoundError } from "./errors.ts";
import { DAILY_TURN_LIMIT } from "./limits.ts";
import type { Blocked, Office } from "./office.ts";
import type { Notification } from "./platform.ts";
import type { TurnBlocker } from "./runtime/types.ts";
import { checkConnection } from "./sources/collect.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import type { Occurrence } from "./store/store.ts";
import { addDays, localDate, localParts, runsOn, scheduledTime, zonedInstant } from "./time.ts";

// The scheduler (DESIGN.md › Scheduling and reporting, Windows lifecycle). The briefing runs on
// weekdays, or every day once the operator turns weekends on. Each day it runs has one occurrence, recorded before it runs and started by one scheduler only, so retries,
// restarts, and a second daemon never deliver twice. A missed briefing is caught up later the same
// day; earlier missed days are skipped, and the next briefing still covers everything, since
// collectors report all changes since their cursor. A health check an hour before tells the
// operator in time to fix what would spoil the briefing.
//
// A briefing Codex can't run yet, because the plan's usage is used up, nobody is signed in, there
// is no connection, or the service is busy, waits and tries again until the end of its day. While a
// briefing is due the daemon keeps the PC awake, and it keeps one wake timer set for the next time
// the PC must be awake. The operator hears about a delivered briefing, the health check's problems,
// and a briefing that waits or gives up, also with the browser closed.

const HEALTH_LEAD_MS = 60 * 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const MAX_ATTEMPTS = 2;
/** Above this share of the plan's usage window, the health check warns. */
const USAGE_WARNING_PERCENT = 90;
/** How long a waiting briefing waits before it tries again, by what it waits for. */
const WAIT_MS: Record<TurnBlocker, number> = { usage: 30 * 60_000, signed_out: 15 * 60_000, offline: 10 * 60_000, busy: 10 * 60_000 };
/** The PC wakes this long before it must be awake, and stays awake from then. */
const WAKE_LEAD_MS = 2 * 60_000;
/** A briefing that waits longer than this lets the PC sleep meanwhile; the wake timer brings it back. */
const AWAKE_WAIT_MS = 20 * 60_000;
const SIGN_IN = " Sign in with `npm run codex -- login`.";

export interface BriefingResult {
  /** The briefing's run, or null if it waited before starting one. */
  run: { id: string; state: string; error: string | null } | null;
  /** Why it didn't go out, when trying again later may fix it. */
  waiting?: Blocked | null;
  /** What it covered, to count what it delivered. */
  sections?: SectionOutcome[];
}

export interface SchedulerOptions {
  now?: () => Date;
  tickMs?: number;
  /** Runs the briefing, or returns null when nobody reports to it yet. Tests replace it. */
  briefing?: (office: Office) => Promise<BriefingResult | null>;
}

export class Scheduler {
  private readonly now: () => Date;
  private readonly briefing: NonNullable<SchedulerOptions["briefing"]>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** The check in progress, so a slow one isn't overlapped by the next. */
  private ticking: Promise<void> | null = null;
  /** The wake time last handed to the platform, so it is only set again when it changes. */
  private wake: string | null | undefined = undefined;

  constructor(
    private readonly office: Office,
    private readonly options: SchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.briefing =
      options.briefing ??
      (async (office) => {
        const sections = await collectSections(office, this.now());
        return sections.length ? runBriefing(office, sections, { now: this.now() }) : null;
      });
  }

  /** Closes out occurrences a restart interrupted, then checks the clock regularly. */
  start() {
    this.office.store.failRunningOccurrences("The daemon stopped during this run.", RETRY_AFTER_MS, MAX_ATTEMPTS);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.office.platform.stayAwake(false);
  }

  /** True while a briefing runs. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Waits for the check and the briefing in progress, for tests and shutdown. */
  async idle() {
    await this.ticking;
    while (this.running) await this.running;
  }

  tick(): Promise<void> {
    this.ticking ??= this.check().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async check() {
    const now = this.now();
    await this.giveUpPastDays(now);
    for (const routine of this.office.store.listRoutines()) {
      const time = scheduledTime(routine.trigger);
      if (routine.paused || !time) continue;
      const today = localDate(now, routine.timezone);
      if (!runsOn(routine.trigger, today)) continue;
      const due = zonedInstant(today, time, routine.timezone);
      if (now >= new Date(due.getTime() - HEALTH_LEAD_MS) && now < due) await this.healthCheck(routine, today);
      if (now >= due) this.runOccurrence(routine, `${routine.id}:${today}`, due);
    }
    this.power(now);
  }

  /** Runs the briefing now, outside the schedule. It doesn't wait or retry: the operator is there. */
  runNow(routineId: string): string {
    const routine = this.office.store.getRoutine(routineId);
    if (!routine) throw new NotFoundError(`No routine ${routineId}`);
    if (this.running) throw new ConflictError("A briefing is already running.");
    const now = this.now();
    const id = `${routine.id}:manual:${now.toISOString()}`;
    this.runOccurrence(routine, id, now, true);
    return id;
  }

  /**
   * A scheduled routine runs on weekends too, or on weekdays only. Turned on after today's time has
   * passed, today's run is skipped rather than run late: the change counts from the next time.
   */
  setWeekends(routineId: string, weekends: boolean): Routine {
    const { store, bus } = this.office;
    const routine = store.getRoutine(routineId);
    if (!routine) throw new NotFoundError(`No routine ${routineId}`);
    const time = scheduledTime(routine.trigger);
    if (!time) throw new InvalidRequestError("This routine is part of the briefing, so it runs on the briefing's days.");
    const trigger: RoutineTrigger = weekends ? { type: "daily", time } : { type: "weekdays", time };
    const now = this.now();
    const today = localDate(now, routine.timezone);
    const due = zonedInstant(today, time, routine.timezone);
    if (!runsOn(routine.trigger, today) && runsOn(trigger, today) && now >= due) {
      const id = `${routine.id}:${today}`;
      if (store.claimOccurrence(id, routine.id, due.toISOString())) store.updateOccurrence(id, { status: "skipped", detail: "Weekends were turned on after its time." });
    }
    store.setRoutineTrigger(routine.id, trigger);
    const updated = store.getRoutine(routine.id)!;
    const published = { ...updated, nextRunAt: this.nextRunAt(updated) };
    bus.publish({ type: "routine", routine: published });
    const summary = `The operator set "${routine.title}" to run ${weekends ? "every day" : "on weekdays only"}`;
    bus.publish({ type: "activity", entry: store.addActivity({ agentId: routine.ownerId, runId: null, kind: "briefing", summary }) });
    this.power(now);
    return published;
  }

  /** The next time a routine runs on its own, for the UI. A waiting briefing runs when it tries again. */
  nextRunAt(routine: Routine): string | null {
    const time = scheduledTime(routine.trigger);
    if (routine.paused || !time) return null;
    const now = this.now();
    let day = localDate(now, routine.timezone);
    for (let n = 0; n < 8; n++, day = addDays(day, 1)) {
      if (!runsOn(routine.trigger, day)) continue;
      const at = zonedInstant(day, time, routine.timezone);
      const claimed = this.office.store.getOccurrence(`${routine.id}:${day}`);
      if (n === 0 && claimed?.retryAt) return claimed.retryAt;
      if (at > now || (!claimed && n === 0)) return at.toISOString();
    }
    return null;
  }

  private runOccurrence(routine: Routine, id: string, scheduledFor: Date, manual = false) {
    const { store } = this.office;
    if (this.running) return;
    store.claimOccurrence(id, routine.id, scheduledFor.toISOString());
    const occurrence = store.getOccurrence(id)!;
    // Another scheduler on the same database may have started it between the read and now.
    if (!this.isDue(occurrence) || !store.startOccurrence(occurrence)) return;
    this.running = this.briefing(this.office)
      .then((outcome) => this.settle(routine, occurrence, outcome, manual))
      .catch((error: unknown) => this.fail(id, error instanceof Error ? error.message : String(error), null, manual))
      .finally(() => {
        this.running = null;
        this.office.bus.publish({ type: "office", office: this.office.officeStats() });
        const updated = store.getRoutine(routine.id);
        if (updated) this.office.bus.publish({ type: "routine", routine: { ...updated, nextRunAt: this.nextRunAt(updated) } });
        this.power(this.now());
      });
  }

  /** A new occurrence runs at once; a waiting or failed one when it is time to try again. */
  private isDue(occurrence: Occurrence): boolean {
    if (occurrence.status === "pending") return true;
    if (occurrence.status !== "waiting" && occurrence.status !== "failed") return false;
    return occurrence.retryAt !== null && Date.parse(occurrence.retryAt) <= this.now().getTime();
  }

  private async settle(routine: Routine, started: Occurrence, outcome: BriefingResult | null, manual: boolean) {
    const { store } = this.office;
    if (!outcome) return store.updateOccurrence(started.id, { status: "skipped", detail: "Nobody reports to the briefing yet." });
    const { run } = outcome;
    if (outcome.waiting) return this.wait(routine, started, run?.id ?? null, outcome.waiting, manual);
    if (run?.state !== "done") return this.fail(started.id, run?.error ?? "The briefing failed.", run?.id ?? null, manual);
    store.updateOccurrence(started.id, { status: "delivered", runId: run.id });
    await this.notify({ title: "Your briefing is ready", body: deliveredText(outcome.sections), tag: "briefing" });
    // Then the staff review, when a warning sign calls for one (DESIGN.md › Staff review). It can't undo the delivery.
    try {
      await this.office.staffReview.afterBriefing(outcome.sections ?? [], this.now());
    } catch (error) {
      console.error("The staff review failed:", error);
    }
  }

  /** A failed briefing tries once more after a pause; after that, the operator hears it gave up. */
  private async fail(id: string, error: string, runId: string | null, manual: boolean) {
    const { store } = this.office;
    const retry = !manual && store.getOccurrence(id)!.attempts < MAX_ATTEMPTS;
    store.updateOccurrence(id, { status: "failed", runId, detail: error, retryAt: retry ? this.later(RETRY_AFTER_MS) : null });
    if (!retry && !manual) await this.gaveUp(`It failed twice: ${sentence(error)}`);
  }

  /**
   * Holds a briefing Codex can't run yet. It tries again when that may have changed, until the end
   * of its day; the attempt it made doesn't count against its retries. The operator hears when it
   * starts waiting and when the reason changes, not at every try.
   */
  private async wait(routine: Routine, started: Occurrence, runId: string | null, blocked: Blocked, manual: boolean) {
    const { store } = this.office;
    if (manual) {
      store.updateOccurrence(started.id, { status: "failed", runId, detail: blocked.detail });
      this.notice(`The briefing can't run now. ${sentence(blocked.detail)}${blocked.blocker === "signed_out" ? SIGN_IN : ""}`);
      return;
    }
    const now = this.now();
    const resets = blocked.blocker === "usage" && blocked.resetsAt && blocked.resetsAt > now ? blocked.resetsAt : null;
    // A minute after the reset, so the plan's new window is surely open.
    const retryAt = resets ? new Date(resets.getTime() + 60_000) : new Date(now.getTime() + WAIT_MS[blocked.blocker]);
    const day = localDate(new Date(started.scheduledFor), routine.timezone);
    if (retryAt >= zonedInstant(addDays(day, 1), "00:00", routine.timezone)) {
      store.updateOccurrence(started.id, { status: "failed", runId, detail: `Gave up. ${sentence(blocked.detail)}`, attempts: -1 });
      await this.gaveUp(sentence(resets ? `${blocked.detail} until ${when(resets, routine.timezone, now)}` : blocked.detail));
      return;
    }
    store.updateOccurrence(started.id, { status: "waiting", runId, detail: blocked.detail, attempts: -1, retryAt: retryAt.toISOString() });
    if (started.status === "waiting" && started.detail === blocked.detail) return;
    const text = resets
      ? `The briefing is waiting for Codex usage to reset at ${clock(resets, routine.timezone)}.`
      : `The briefing is waiting. ${sentence(blocked.detail)}${blocked.blocker === "signed_out" ? SIGN_IN : ""} It tries again at ${clock(retryAt, routine.timezone)}, and until the end of the day.`;
    this.notice(text);
    await this.notify({ title: "Your briefing is waiting", body: text, tag: "briefing" });
  }

  /** A waiting briefing from an earlier day, such as when the daemon was off at midnight, gives up. */
  private async giveUpPastDays(now: Date) {
    const { store } = this.office;
    for (const occurrence of store.occurrencesIn("waiting")) {
      const routine = store.getRoutine(occurrence.routineId);
      const timeZone = routine?.timezone;
      if (localDate(new Date(occurrence.scheduledFor), timeZone) >= localDate(now, timeZone)) continue;
      const reason = sentence(occurrence.detail ?? "It waited all day");
      store.updateOccurrence(occurrence.id, { status: "failed", detail: `Gave up. ${reason}` });
      await this.gaveUp(reason, "That day's briefing didn't go out.");
    }
  }

  private async gaveUp(reason: string, lead = "Today's briefing didn't go out.") {
    const text = `${lead} ${reason} The next briefing covers what it would have.`;
    this.notice(text);
    await this.notify({ title: "No briefing today", body: text, tag: "briefing" });
  }

  /**
   * Keeps the PC awake from shortly before the health check until the briefing is settled, and
   * sets the wake timer for the next time it must be awake: the next health check, or a waiting
   * briefing's next try when that is far enough off to let the PC sleep meanwhile.
   */
  private power(now: Date) {
    const { store, platform } = this.office;
    let awake = this.running !== null;
    const wakes: number[] = [];
    for (const routine of store.listRoutines()) {
      const time = scheduledTime(routine.trigger);
      if (routine.paused || !time) continue;
      const { timezone: timeZone, trigger } = routine;
      const today = localDate(now, timeZone);
      if (runsOn(trigger, today)) {
        const due = zonedInstant(today, time, timeZone).getTime();
        const occurrence = store.getOccurrence(`${routine.id}:${today}`);
        const retryAt = occurrence?.retryAt ? Date.parse(occurrence.retryAt) : null;
        const settled = !!occurrence && occurrence.status !== "pending" && occurrence.status !== "running" && retryAt === null;
        if (!settled && now.getTime() >= due - HEALTH_LEAD_MS - WAKE_LEAD_MS) {
          if (retryAt !== null && retryAt - now.getTime() > AWAKE_WAIT_MS) wakes.push(retryAt - WAKE_LEAD_MS);
          else awake = true;
        }
      }
      for (let n = 0, day = today; n < 8; n++, day = addDays(day, 1)) {
        if (!runsOn(trigger, day)) continue;
        const at = zonedInstant(day, time, timeZone).getTime() - HEALTH_LEAD_MS - WAKE_LEAD_MS;
        if (at > now.getTime()) {
          wakes.push(at);
          break;
        }
      }
    }
    platform.stayAwake(awake);
    const next = wakes.length ? new Date(Math.min(...wakes)).toISOString() : null;
    if (next === this.wake) return;
    this.wake = next;
    void platform.wakeAt(next ? new Date(next) : null);
  }

  /** Checks sign-in, sources, and usage before the briefing, and says what to fix. */
  private async healthCheck(routine: Routine, today: string) {
    const { store, bus } = this.office;
    if (!store.claimOccurrence(`${routine.id}:${today}:health`, routine.id, this.now().toISOString())) return;
    const problems: string[] = [];
    const { signedIn, unavailable } = await this.office.checkRuntime();
    if (unavailable) problems.push(sentence(unavailable));
    else if (!signedIn) problems.push(`Codex isn't signed in.${SIGN_IN}`);
    for (const { id } of store.listConnections()) {
      const { connection, warning } = await checkConnection(store, id, this.office.sourceContext(this.now()));
      bus.publish({ type: "connection", connection });
      if (connection.status !== "connected") problems.push(`${connection.label}: ${connection.detail}`);
      else if (warning) problems.push(`${connection.label}: ${warning}`);
    }
    const usage = await this.office.usageLimits().catch(() => null);
    if (usage?.exhausted) {
      const resets = usage.resetsAt ? ` until ${when(usage.resetsAt, routine.timezone, this.now())}` : "";
      problems.push(`The Codex plan's usage is used up${resets}, so the briefing will wait for it.`);
    } else if (usage && usage.usedPercent >= USAGE_WARNING_PERCENT) {
      problems.push(`The Codex plan's usage window is ${usage.usedPercent}% used, so the briefing may not finish.`);
    }
    if (this.office.officeStats().turnsToday >= DAILY_TURN_LIMIT) problems.push("Today's turn budget is already used up.");
    store.updateOccurrence(`${routine.id}:${today}:health`, { status: "delivered", detail: problems.join("\n") || null });

    const summary = problems.length ? `Health check: ${problems.length} problem${problems.length === 1 ? "" : "s"} before the briefing` : "Health check passed";
    bus.publish({ type: "activity", entry: store.addActivity({ agentId: CHIEF_OF_STAFF_ID, runId: null, kind: "health", summary }) });
    if (!problems.length) return;
    const time = scheduledTime(routine.trigger) ?? "the briefing";
    const heading = `Before ${time}, ${problems.length === 1 ? "one thing needs" : `${problems.length} things need`} you`;
    this.notice(`${heading}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    await this.notify({
      title: heading,
      body: problems.slice(0, 3).join("\n"),
      tag: "health",
    });
  }

  private notice(text: string) {
    this.office.postMessage(CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID, text, null, "notice");
  }

  /** Notifications lead to the office, and say no more than counts and what to fix: they can show on a locked screen. */
  private notify(notification: Notification) {
    return this.office.platform.notify({ path: "/", ...notification });
  }

  private later(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}

/** How many of the new items need the operator, said only when it isn't all of them. */
function needing(count: number, of: number): string {
  if (count === of) return "";
  return count === 0 ? ", nothing needs you" : `, ${count} need${count === 1 ? "s" : ""} you`;
}

/** What a delivered briefing holds, in counts only. */
function deliveredText(sections: SectionOutcome[] | undefined): string {
  if (!sections) return "Open the office to read it.";
  const items = sections.flatMap((section) => ("newItems" in section ? section.newItems : []));
  const urgent = items.filter((item) => item.urgency === "urgent").length;
  const needsYou = items.filter((item) => item.needsOperator).length;
  const gaps = sections.filter((section) => section.status === "missing" || section.status === "unavailable").length;
  const parts = [
    items.length
      ? `${items.length} new item${items.length === 1 ? "" : "s"}${needing(needsYou, items.length)}${urgent ? `, ${urgent} urgent` : ""}.`
      : "Nothing new.",
    gaps ? `${gaps} section${gaps === 1 ? "" : "s"} couldn't report.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** "09:12" in the routine's timezone. */
export function clock(at: Date, timeZone: string): string {
  const { hour, minute } = localParts(at, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "09:12" today, or "Friday 09:12" on another day. */
function when(at: Date, timeZone: string, now: Date): string {
  if (localDate(at, timeZone) === localDate(now, timeZone)) return clock(at, timeZone);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone }).format(at);
  return `${day} ${clock(at, timeZone)}`;
}

/** The text ending in one full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}
