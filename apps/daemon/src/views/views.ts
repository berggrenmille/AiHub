import type { ActivityKind, View, ViewKind } from "@aihub/shared";
import { checkView, viewGuide, type GuideKind } from "@aihub/views";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { Caller, ViewService } from "../gateway/gateway.ts";
import type { Office } from "../office.ts";

// Views (DESIGN.md › Views): staff hand in OpenUI Lang programs through gateway tools, AiHub checks
// each one and keeps those that pass. A view in a reply or a briefing section shows under the message
// it came with; a dashboard is saved for the operator to open. Whether a view's outside images load by
// themselves is decided here, from what its author could have read, never from the program.

/** Failed checks a run may have before it is told to answer in text. */
export const MAX_FAILED_CHECKS = 3;
/** Views one reply may carry. A briefing section carries one. */
export const MAX_REPLY_VIEWS = 3;
export const MAX_DASHBOARDS = 30;

export class Views implements ViewService {
  /** Failed checks per run, so a model that can't write a valid view stops trying. */
  private readonly failed = new Map<string, number>();
  /** Runs that read what another staff member or the office holds, such as an Office note. */
  private readonly personal = new Set<string>();
  /** Chat turns in progress: their views show under the reply they post. */
  private readonly replies = new Set<string>();

  constructor(private readonly office: Office) {}

  tookInPersonal(runId: string) {
    this.personal.add(runId);
  }

  /** A chat turn starts. A follow-up that delivers a task instead posts no reply, so it shows no view. */
  replying(runId: string) {
    this.replies.add(runId);
  }

  /** Clears what a finished run left here. */
  forget(runId: string) {
    this.failed.delete(runId);
    this.personal.delete(runId);
    this.replies.delete(runId);
  }

  guide(caller: Caller, kind: GuideKind): string {
    if (kind === "dashboard" && this.office.store.getRun(caller.runId)?.kind !== "chat") {
      throw new Error("Dashboards are made in chat, when the operator asks for one.");
    }
    return viewGuide(kind);
  }

  /** A view under the caller's chat reply, or on its briefing section. */
  show(caller: Caller, input: { title: string; program: string }): string {
    const { store } = this.office;
    const run = store.getRun(caller.runId);
    if (!run) throw new NotFoundError(`No run ${caller.runId}`);
    const kind: ViewKind = run.kind === "report" ? "section" : "reply";
    if (kind === "reply" && !this.replies.has(run.id)) throw new Error("A view shows only with a chat reply or a briefing section. Put this in words.");
    const handedIn = store.viewsOfRun(run.id);
    if (kind === "reply" && handedIn.length >= MAX_REPLY_VIEWS) throw new Error(`A reply carries at most ${MAX_REPLY_VIEWS} views. Put the rest in words.`);
    const notes = this.check(caller, input.program, false);
    if (kind === "section" && handedIn[0]) {
      store.updateView(handedIn[0].id, { runId: run.id, title: input.title, program: input.program });
      return `Replaced the view on your section of the briefing.${notes}`;
    }
    store.addView({ kind, agentId: caller.agentId, runId: run.id, title: input.title, program: input.program, outside: this.outsideFor(caller, kind) });
    return kind === "section"
      ? `Attached to your section of the briefing. Now file your report as usual.${notes}`
      : `It shows under your reply. Still say in words what matters.${notes}`;
  }

  /** Saves a dashboard, or a new version of one the caller saved under the same title. */
  saveDashboard(caller: Caller, input: { title: string; program: string }): string {
    const { store, bus } = this.office;
    const agent = store.getAgent(caller.agentId);
    if (!agent) throw new NotFoundError(`No agent ${caller.agentId}`);
    const notes = this.check(caller, input.program, true);
    const existing = store.findDashboard(caller.agentId, input.title);
    if (!existing && store.dashboards().length >= MAX_DASHBOARDS) {
      throw new Error(`The office has ${MAX_DASHBOARDS} dashboards, the most it keeps. Ask the operator to remove one first.`);
    }
    // Dashboards fetch office data, so their outside images always wait for a click.
    const view = existing
      ? store.updateView(existing.id, { runId: caller.runId, title: input.title, program: input.program })
      : store.addView({ kind: "dashboard", agentId: caller.agentId, runId: caller.runId, title: input.title, program: input.program, outside: "ask" });
    bus.publish({ type: "view", view });
    this.activity(agent.id, caller.runId, "view", `${agent.name} ${existing ? "updated" : "made"} the dashboard "${view.title}"`);
    this.office.notebook.journal(agent.id, `${existing ? "Updated" : "Made"} the dashboard "${view.title}" for the operator.`, caller.runId);
    return `Saved "${view.title}". The operator opens it from the Dashboards panel; tell them in a sentence what it shows. To change it later, save it again under the same title.${notes}`;
  }

  /** Shows the views the runs handed in under a message just posted, such as a reply or the briefing. */
  attach(runIds: string[], messageId: number): View[] {
    const views = this.office.store.attachViews(runIds, messageId);
    for (const view of views) this.office.bus.publish({ type: "view", view });
    return views;
  }

  /** Whether any of the runs handed in a view not yet shown. */
  pending(runId: string): boolean {
    return this.office.store.viewsOfRun(runId).some((view) => view.kind !== "dashboard" && view.messageId === null);
  }

  /** The operator removes a dashboard. A view under a message is part of the record and stays. */
  remove(id: string): View {
    const { store, bus } = this.office;
    const view = store.getView(id);
    if (!view) throw new NotFoundError(`No view ${id}`);
    if (view.kind !== "dashboard") throw new ConflictError("Only a dashboard can be removed. A view under a message stays with it.");
    store.removeView(id);
    bus.publish({ type: "view_removed", viewId: id });
    this.activity(view.agentId, null, "view", `The operator removed the dashboard "${view.title}"`);
    return view;
  }

  /**
   * Outside images and pages load by themselves only in a briefing section by a supervisor that reads
   * no source and read nothing of anyone else's in that run: it holds no personal data to carry out.
   * A chat holds what the operator says, and a dashboard shows office data, so theirs wait for a click.
   */
  private outsideFor(caller: Caller, kind: ViewKind): View["outside"] {
    if (kind !== "section") return "ask";
    const { store } = this.office;
    const agent = store.getAgentRecord(caller.agentId);
    if (agent?.role !== "supervisor") return "ask";
    if (store.connectionsOf(agent.id).length > 0 || this.personal.has(caller.runId)) return "ask";
    return "load";
  }

  /** Checks a program, returning notes for the staff member, or throwing what to fix. */
  private check(caller: Caller, program: string, fetches: boolean): string {
    const failures = this.failed.get(caller.runId) ?? 0;
    if (failures >= MAX_FAILED_CHECKS) throw new Error("This run's views kept failing the check, so no more are taken. Answer in text this time.");
    const { problems, notes } = checkView(program, { fetches });
    if (problems.length) {
      this.failed.set(caller.runId, failures + 1);
      const last = failures + 1 >= MAX_FAILED_CHECKS;
      throw new Error(
        `The view has problems, so it isn't shown:\n- ${problems.join("\n- ")}\n${last ? "That was the last try in this run: answer in text." : "Fix them and call again."}`,
      );
    }
    return notes.length ? `\nNote: ${notes.join(" ")}` : "";
  }

  private activity(agentId: string | null, runId: string | null, kind: ActivityKind, summary: string) {
    this.office.bus.publish({ type: "activity", entry: this.office.store.addActivity({ agentId, runId, kind, summary }) });
  }
}
