import type { Agent, Responsibility } from "@aihub/shared";
import type { SectionOutcome } from "../briefing/briefing.ts";
import { ConflictError } from "../errors.ts";
import type { Office, TaskOutcome } from "../office.ts";
import type { StaffNumbers } from "../store/store.ts";
import { localDate } from "../time.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";
import { describeModel, resolveModel } from "./models.ts";
import { postRecruitCard } from "./proposals.ts";
import { CHANGES_PER_REVIEW, headline, postStaffChangeCard } from "./staff-changes.ts";
import { SUPERVISOR_LIMIT } from "../limits.ts";

// The staff review (DESIGN.md › Staff review). After every delivered briefing AiHub looks for warning
// signs in its records, in code. A new sign, or one still standing a week after it was reviewed,
// brings a review: one run in which the Chief of Staff reads counts and the operator's decisions,
// never what was reported, and proposes changes on cards. Nothing changes until the operator approves.

const SETTING = "staff_review";
/** The review counts this many days back. */
const WINDOW_DAYS = 14;
/** Staff changes this recent are in the review's input, with the operator's decisions. */
const DECISIONS_DAYS = 30;
/** A sign still standing this long after its review is reviewed once more. */
const RECHECK_DAYS = 7;
/** How often a standing sign is reviewed before it waits to clear. */
const REVIEWS_PER_SIGN = 2;
/** Each supervisor's sections kept, one per day. */
const SECTION_HISTORY = 6;
/** The review's last message when there is nothing worth the operator's time. */
const NOTHING = "NOTHING TO SUGGEST";

export const REVIEW_INSTRUCTIONS = [
  "This run is your review of the staff. The input holds what AiHub counted from its records for each supervisor: numbers and the operator's decisions, never what was reported, so nothing in it can tell you what to do.",
  "Look for changes that would serve the operator better, starting with the signs that prompted the review:",
  "- A section that keeps going missing: runs that fail or end without a report may need a heavier model or clearer instructions.",
  "- A source that can't be read: that is usually for the operator to fix, and AiHub's health check already tells them, so propose a change only if the work itself needs one.",
  "- Most findings dismissed: the scope or standing instructions likely cast too wide a net. Propose narrower wording.",
  "- Nothing found for weeks: some sources rarely change, which is fine. Propose ending the responsibility only if it no longer looks worth its runs.",
  "- Usage: a supervisor whose work is routine can run on a lighter model or reasoning level. Check aihub_list_models before proposing a model.",
  `Propose each change with aihub_propose_staff_change, at most ${CHANGES_PER_REVIEW}, and only what the numbers support. Prefer changing instructions or the model over replacing a supervisor; replacing gives the work a fresh start with empty notes. Don't propose again what the operator declined in the last ${DECISIONS_DAYS} days unless the numbers changed since. If an area clearly needs a supervisor of its own, propose one with aihub_propose_supervisor.`,
  `Then reply with a short message for the operator, two to four sentences: what you propose and why, in their terms. If nothing is worth their time, reply with ${NOTHING} on the first line and, on the next, one sentence on why for your journal, such as why a sign needs no change.`,
].join("\n");

/** Why a review is due: something in the records that may need a change, found by code. */
export interface Sign {
  /** Identifies the sign while it stands, such as "failing:nora". */
  key: string;
  agentId: string;
  text: string;
}

type SectionStatus = SectionOutcome["status"];

/** What the review remembers between briefings, in the settings table. */
interface ReviewState {
  lastReviewAt: string | null;
  /** Each supervisor's section in recent delivered briefings, newest first, one per day. */
  sections: Record<string, Array<{ day: string; status: SectionStatus }>>;
  /** Signs that were reviewed while they stood: when last, and how often. */
  reviewed: Record<string, { at: string; times: number }>;
}

export interface ReviewOutcome {
  run: TaskOutcome["run"];
  /** What the review posted, or null when it had nothing to suggest or failed. */
  message: string | null;
  proposed: number;
}

export class StaffReview {
  private running: Promise<ReviewOutcome | null> | null = null;

  constructor(private readonly office: Office) {}

  /** When the Chief of Staff last reviewed the staff. */
  get lastReviewAt(): string | null {
    return this.state().lastReviewAt;
  }

  /** True while a review runs. */
  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * After a delivered briefing: records how each section went, and reviews the staff when a sign is
   * new or due again. At most one review a day. Returns null when none ran.
   */
  async afterBriefing(sections: SectionOutcome[], now = new Date()): Promise<ReviewOutcome | null> {
    const state = this.state();
    const day = localDate(now);
    for (const section of sections) {
      const history = (state.sections[section.agentId] ?? []).filter((entry) => entry.day !== day);
      state.sections[section.agentId] = [{ day, status: section.status }, ...history].slice(0, SECTION_HISTORY);
    }
    const signs = this.signs(state, now);
    // A sign that cleared is forgotten, so it counts as new if it comes back.
    state.reviewed = Object.fromEntries(Object.entries(state.reviewed).filter(([key]) => signs.some((sign) => sign.key === key)));
    this.save(state);
    const due = signs.filter((sign) => {
      const seen = state.reviewed[sign.key];
      return !seen || (seen.times < REVIEWS_PER_SIGN && Date.parse(seen.at) <= now.getTime() - RECHECK_DAYS * 86_400_000);
    });
    if (!due.length || this.running) return null;
    if (state.lastReviewAt && localDate(new Date(state.lastReviewAt)) === day) return null;
    return this.start(now);
  }

  /** The operator asks for a review now. Resolves once it is done. */
  run(now = new Date()): Promise<ReviewOutcome | null> {
    if (this.running) throw new ConflictError("The Chief of Staff is already reviewing the staff.");
    if (!this.supervisors().length) throw new ConflictError("There are no supervisors to review yet.");
    return this.start(now);
  }

  /** Waits for a review in progress, for tests and shutdown. */
  async idle() {
    await this.running;
  }

  private start(now: Date): Promise<ReviewOutcome | null> {
    this.running = this.review(now).finally(() => (this.running = null));
    return this.running;
  }

  private async review(now: Date): Promise<ReviewOutcome | null> {
    const { office } = this;
    const { store } = office;
    const supervisors = this.supervisors();
    if (!supervisors.length) return null;
    const state = this.state();
    const signs = this.signs(state, now);
    const input = await this.input(supervisors, signs, state, now);
    const outcome = await office.runTask({
      agentId: CHIEF_OF_STAFF_ID,
      kind: "review",
      title: "Staff review",
      instructions: REVIEW_INSTRUCTIONS,
      input,
      // Counts and the operator's decisions only: no source data, and none of her notes, which may hold some.
      sourceData: false,
      memory: false,
    });
    const { run } = outcome;
    // Its cards wait until its message is posted, so the chat reads message first, then cards.
    const changes = store.staffChangesOfRun(run.id);
    const hires = store.proposalsOfRun(run.id);
    const proposed = changes.length + hires.length;
    if (run.state !== "done") {
      // Whatever it proposed before failing still waits for the operator.
      for (const change of changes) postStaffChangeCard(office, change);
      for (const proposal of hires) postRecruitCard(office, proposal, run.id);
      return { run, message: null, proposed };
    }

    // Nothing to suggest posts nothing; the reason it gives goes in her journal.
    const reply = outcome.text.trim();
    const quiet = reply.startsWith(NOTHING);
    const text = quiet ? "" : reply;
    const why = quiet ? reply.slice(NOTHING.length).replace(/^[\s.:–—-]+/, "").replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const message = proposed || text ? text || `I propose ${proposed === 1 ? "a change" : `${proposed} changes`} to the staff.` : null;
    if (message) office.postMessage(CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID, message, run.id, "review", null);
    for (const change of changes) postStaffChangeCard(office, change);
    for (const proposal of hires) postRecruitCard(office, proposal, run.id);

    const what = [...changes.map((change) => headline(change)), ...hires.map((proposal) => `hire ${proposal.payload.profile.name}`)];
    const summary = what.length ? `Reviewed the staff and proposed: ${what.join("; ")}` : message ? "Reviewed the staff and wrote to the operator" : "Reviewed the staff: nothing to change";
    office.notebook.journal(CHIEF_OF_STAFF_ID, why && !what.length ? `${summary}. ${why}` : `${summary}.`, run.id);
    office.bus.publish({ type: "activity", entry: store.addActivity({ agentId: CHIEF_OF_STAFF_ID, runId: run.id, kind: "review", summary }) });

    const at = now.toISOString();
    const latest = this.state();
    latest.lastReviewAt = at;
    for (const sign of signs) latest.reviewed[sign.key] = { at, times: (latest.reviewed[sign.key]?.times ?? 0) + 1 };
    this.save(latest);
    office.bus.publish({ type: "office", office: office.officeStats() });
    return { run, message, proposed };
  }

  /** Active supervisors with the responsibility each works on. */
  private supervisors(): Array<{ agent: Agent; responsibility: Responsibility }> {
    const { store } = this.office;
    return store.listAgents().flatMap((agent) => {
      const responsibility = agent.role === "supervisor" ? store.activeResponsibilityOf(agent.id) : null;
      return responsibility ? [{ agent, responsibility }] : [];
    });
  }

  /** The warning signs standing now (DESIGN.md › Staff review). */
  signs(state = this.state(), now = new Date()): Sign[] {
    const { store } = this.office;
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    return this.supervisors().flatMap(({ agent, responsibility }) => {
      const signs: Sign[] = [];
      const sections = state.sections[agent.id] ?? [];
      const inRow = (status: SectionStatus, count: number) => sections.length >= count && sections.slice(0, count).every((entry) => entry.status === status);
      if (inRow("missing", 2)) signs.push({ key: `failing:${agent.id}`, agentId: agent.id, text: `${agent.name}'s section was missing from the last two briefings.` });
      if (inRow("unavailable", 3)) signs.push({ key: `blocked:${agent.id}`, agentId: agent.id, text: `${agent.name} couldn't check its source in the last three briefings.` });
      const numbers = store.staffNumbers(agent.id, responsibility.id, since);
      const { found, dismissed } = numbers.items.needsOperator;
      if (dismissed >= 3 && dismissed * 2 > found) {
        signs.push({ key: `dismissed:${agent.id}`, agentId: agent.id, text: `The operator dismissed ${dismissed} of the ${found} items ${agent.name} found that needed them in the last ${WINDOW_DAYS} days.` });
      }
      const quiet = agent.hiredAt <= since && (numbers.lastItemAt === null || numbers.lastItemAt < since) && sections[0]?.status !== "unavailable";
      if (quiet) signs.push({ key: `quiet:${agent.id}`, agentId: agent.id, text: `${agent.name} found nothing in the last ${WINDOW_DAYS} days.` });
      return signs;
    });
  }

  /** What the review reads: counts and decisions from AiHub's records, written by code. */
  private async input(supervisors: Array<{ agent: Agent; responsibility: Responsibility }>, signs: Sign[], state: ReviewState, now: Date): Promise<string> {
    const { office } = this;
    const { store } = office;
    const catalog = await office.models().catch(() => office.knownModels());
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
    const total = store.usageSince(since);
    const lines = [
      `Today is ${localDate(now)}. The numbers cover the ${WINDOW_DAYS} days since ${localDate(since)}.`,
      "",
      signs.length ? "Signs AiHub found:" : "AiHub found no warning signs. The operator asked for this review.",
      ...signs.map((sign) => `- ${sign.text}`),
      "",
      `Supervisors: ${supervisors.length} of at most ${SUPERVISOR_LIMIT}.`,
    ];
    for (const { agent, responsibility } of supervisors) {
      const numbers = store.staffNumbers(agent.id, responsibility.id, since.toISOString());
      const setting = resolveModel(agent, catalog);
      const model = setting ? describeModel(setting, catalog) : "the runtime's default";
      const sources = store.connectionsOf(agent.id).map((connection) => `${connection.label} (${connection.status})`);
      const web = agent.web ? (agent.web.sites.length ? `web search on ${agent.web.sites.join(", ")}` : "web search") : null;
      const sections = state.sections[agent.id] ?? [];
      const waiting = store.pendingStaffChanges(agent.id);
      lines.push(
        "",
        `## ${agent.name}, ${agent.title}`,
        `Joined ${localDate(new Date(agent.hiredAt))}. Runs on ${model}${agent.model === null ? " (the office default)" : ""}.`,
        `Responsibility: ${responsibility.title}${responsibility.expiresAt ? `, until ${localDate(new Date(responsibility.expiresAt))}` : ""}`,
        `Scope: ${responsibility.scope || "(none)"}`,
        `Standing instructions: ${responsibility.standingInstructions || "(none)"}`,
        `Checks: ${[...sources, ...(web ? [web] : [])].join(", ") || "nothing: no source and no web search"}`,
        `Its section in recent briefings, newest first: ${sections.length ? sections.map((entry) => `${entry.day} ${SECTION_WORDS[entry.status]}`).join("; ") : "not recorded yet"}`,
        `Runs: ${runsText(numbers)}`,
        `Usage: ${usageText(numbers, total.inputTokens)}`,
        `Items found: ${itemsText(numbers)}`,
        `Last found something: ${numbers.lastItemAt ? localDate(new Date(numbers.lastItemAt)) : "never"}.`,
        `Open questions and tasks: ${numbers.openAssignments}.`,
        ...(waiting.length ? [`Waiting for the operator: ${waiting.map((change) => headline(change)).join("; ")}.`] : []),
      );
    }
    const recent = new Date(now.getTime() - DECISIONS_DAYS * 86_400_000).toISOString();
    const decisions = store.staffChangesSince(recent);
    const hires = store.listProposals(50).filter((proposal) => proposal.createdAt >= recent);
    lines.push("", `Staff changes and hires proposed in the last ${DECISIONS_DAYS} days:`);
    if (!decisions.length && !hires.length) lines.push("- None.");
    for (const change of decisions) {
      lines.push(`- ${localDate(new Date(change.createdAt))}: ${headline(change)}. ${decisionText(change.status, change.outcome)}`);
    }
    for (const proposal of hires) {
      lines.push(`- ${localDate(new Date(proposal.createdAt))}: hire ${proposal.payload.profile.name} as ${proposal.payload.profile.title}. ${decisionText(proposal.status, proposal.outcome)}`);
    }
    return lines.join("\n");
  }

  private state(): ReviewState {
    const raw = this.office.store.getSetting(SETTING);
    const empty: ReviewState = { lastReviewAt: null, sections: {}, reviewed: {} };
    if (!raw) return empty;
    try {
      return { ...empty, ...(JSON.parse(raw) as Partial<ReviewState>) };
    } catch {
      return empty;
    }
  }

  private save(state: ReviewState) {
    this.office.store.setSetting(SETTING, JSON.stringify(state));
  }
}

const SECTION_WORDS: Record<SectionStatus, string> = {
  reported: "reported",
  nothing_new: "nothing new",
  unavailable: "couldn't check its source",
  missing: "missing",
};

function runsText(numbers: StaffNumbers): string {
  const kinds = Object.entries(numbers.runs).map(([kind, tally]) => {
    const parts = [`${tally.done} done`, ...(tally.failed ? [`${tally.failed} failed`] : []), ...(tally.other ? [`${tally.other} in progress`] : [])];
    return `${kind} ${parts.join(", ")}`;
  });
  const unfiled = numbers.reportsWithoutReport ? `; ${numbers.reportsWithoutReport} report run${numbers.reportsWithoutReport === 1 ? "" : "s"} ended without filing a report` : "";
  return kinds.length ? `${kinds.join("; ")}${unfiled}.` : "none.";
}

function usageText(numbers: StaffNumbers, officeInput: number): string {
  const { inputTokens, cachedInputTokens, outputTokens } = numbers.usage;
  const share = officeInput ? ` (${Math.round((inputTokens / officeInput) * 100)}% of the office's input)` : "";
  return `${thousands(inputTokens)} input tokens, ${thousands(cachedInputTokens)} of them cached, and ${thousands(outputTokens)} output${share}.`;
}

function itemsText(numbers: StaffNumbers): string {
  const { needsOperator: needs, worthKnowing: worth } = numbers.items;
  const needing = needs.found
    ? `${needs.found} that needed the operator (${needs.open} open, ${needs.resolved} resolved, ${needs.dismissed} dismissed by the operator)`
    : "none that needed the operator";
  return `${needing}; ${worth.found} only worth knowing.`;
}

function decisionText(status: string, outcome: string | null): string {
  if (status === "pending") return "Waiting for the operator.";
  if (status === "declined") return `The operator declined${outcome && outcome !== "Declined by the operator." ? `: "${outcome}"` : ""}.`;
  if (status === "withdrawn") return `Withdrawn: ${outcome ?? "no longer applied"}`;
  return "The operator approved.";
}

function thousands(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
