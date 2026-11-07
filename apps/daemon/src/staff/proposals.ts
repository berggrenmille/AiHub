import type { Proposal, RecruitProposal } from "@aihub/shared";
import type { Caller } from "../gateway/gateway.ts";
import { SUPERVISOR_LIMIT } from "../limits.ts";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors.ts";
import type { Office } from "../office.ts";
import { readCalendarFile } from "../sources/ics.ts";
import { verifyConnection } from "../sources/collect.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";
import { SUPERVISOR_CHARTER } from "./supervisor.ts";

// Recruitment (DESIGN.md › Recruitment and delegation). The Chief of Staff proposes; the operator
// approves from a card; the daemon checks the caps and creates everything in one transaction.

/** Turns a briefing section's run budget into a daily cap per supervisor. */
const SUPERVISOR_DAILY_TURNS = 4;

/** The supervisor cap counts proposals still waiting, so approving them all can't exceed it. */
function seatsLeft(office: Office): number {
  const pending = office.store.listProposals(200).filter((proposal) => proposal.status === "pending").length;
  return SUPERVISOR_LIMIT - office.store.countActive("supervisor") - pending;
}

/** Called by the Chief of Staff's tool. Throws with a reason the model can act on. */
export function proposeSupervisor(office: Office, caller: Caller, payload: RecruitProposal): Proposal {
  const { store, bus } = office;
  if (store.isNameTaken(payload.profile.name)) throw new Error(`Someone on staff is already called ${payload.profile.name}. Pick another name.`);
  if (seatsLeft(office) <= 0) {
    throw new Error(`The office is at its cap of ${SUPERVISOR_LIMIT} supervisors, counting pending proposals. Suggest extending an existing responsibility instead.`);
  }
  const proposal = store.createProposal({ proposedBy: caller.agentId, runId: caller.runId, payload });
  bus.publish({ type: "proposal", proposal });
  bus.publish({
    type: "activity",
    entry: store.addActivity({ agentId: caller.agentId, runId: caller.runId, kind: "proposal", summary: `Proposed hiring ${payload.profile.name} as ${payload.profile.title}` }),
  });
  office.postMessage(
    CHIEF_OF_STAFF_CONVERSATION_ID,
    caller.agentId,
    `Proposal: hire ${payload.profile.name} as ${payload.profile.title}. ${payload.reason}`,
    caller.runId,
    "proposal",
    proposal.id,
  );
  return proposal;
}

/** The operator approves: hire the supervisor with its responsibility, routine, and access. */
export function approveProposal(office: Office, id: string, options: { sourcePath?: string } = {}): Proposal {
  const { store, bus, notebook } = office;
  const proposal = store.getProposal(id);
  if (!proposal) throw new NotFoundError(`No proposal ${id}`);
  if (proposal.status !== "pending") throw new ConflictError(`This proposal was already ${proposal.status}.`);
  const { profile, responsibility: duty, source } = proposal.payload;
  // The caps are checked again: the office may have changed since the proposal was made.
  if (store.isNameTaken(profile.name)) throw new ConflictError(`Someone on staff is already called ${profile.name}.`);
  if (SUPERVISOR_LIMIT - store.countActive("supervisor") <= 0) throw new ConflictError(`The office is at its cap of ${SUPERVISOR_LIMIT} supervisors.`);

  const sourcePath = options.sourcePath?.trim().replace(/^"(.*)"$/, "$1");
  if (source && !sourcePath) throw new InvalidRequestError(`Pick the file for ${source.label} to approve this proposal.`);
  if (source && sourcePath) {
    // Read the file before hiring anyone, so a wrong path is fixed on the card, not after.
    try {
      readCalendarFile(sourcePath, { from: new Date(), to: new Date(Date.now() + 86_400_000) });
    } catch (error) {
      throw new InvalidRequestError(`AiHub can't read ${sourcePath} as a calendar export: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const hired = store.transaction(() => {
    const agentId = store.freeAgentId(profile.name);
    store.upsertAgent({ id: agentId, ...profile, role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: SUPERVISOR_CHARTER });
    const responsibility = store.createResponsibility({ ownerId: agentId, ...duty });
    const routine = store.createRoutine({
      ownerId: agentId,
      responsibilityId: responsibility.id,
      title: `${responsibility.title} for the briefing`,
      trigger: { type: "briefing" },
      timezone: "Europe/Stockholm",
      dailyTurnBudget: SUPERVISOR_DAILY_TURNS,
    });
    const connection = source && sourcePath ? store.createConnection({ kind: source.kind, label: source.label, path: sourcePath }) : null;
    if (connection) store.grant(agentId, connection.id, ["read"]);
    const decided = store.decideProposal(id, "approved", `Hired ${profile.name} as ${profile.title}.`)!;
    return { agentId, responsibility, routine, connection, decided };
  });

  const connection = hired.connection ? verifyConnection(store, hired.connection.id) : null;
  notebook.syncProfile(hired.agentId);
  notebook.journal(CHIEF_OF_STAFF_ID, `The operator approved hiring [[${profile.name}]] as ${profile.title}.`);
  bus.publish({ type: "proposal", proposal: hired.decided });
  bus.publish({ type: "responsibility", responsibility: hired.responsibility });
  bus.publish({ type: "routine", routine: hired.routine });
  if (connection) bus.publish({ type: "connection", connection });
  for (const agent of [store.getAgent(hired.agentId), store.getAgent(CHIEF_OF_STAFF_ID)]) if (agent) bus.publish({ type: "agent", agent });
  bus.publish({ type: "office", office: office.officeStats() });
  bus.publish({
    type: "activity",
    entry: store.addActivity({ agentId: hired.agentId, runId: null, kind: "approved", summary: `${profile.name} joined as ${profile.title}` }),
  });
  const access = connection
    ? connection.status === "connected"
      ? ` ${source!.label} is connected: ${connection.detail}.`
      : ` ${source!.label} isn't readable yet: ${connection.detail}`
    : "";
  office.postMessage(
    CHIEF_OF_STAFF_CONVERSATION_ID,
    CHIEF_OF_STAFF_ID,
    `${profile.name} joined as ${profile.title} and reports in the next morning briefing.${access}`,
    null,
    "notice",
    id,
  );
  return hired.decided;
}

export function declineProposal(office: Office, id: string, reason?: string): Proposal {
  const { store, bus } = office;
  const proposal = store.getProposal(id);
  if (!proposal) throw new NotFoundError(`No proposal ${id}`);
  const decided = store.decideProposal(id, "declined", reason?.trim() || "Declined by the operator.");
  if (!decided) throw new ConflictError(`This proposal was already ${proposal.status}.`);
  bus.publish({ type: "proposal", proposal: decided });
  bus.publish({
    type: "activity",
    entry: store.addActivity({ agentId: CHIEF_OF_STAFF_ID, runId: null, kind: "declined", summary: `The operator declined hiring ${proposal.payload.profile.name}` }),
  });
  office.notebook.journal(CHIEF_OF_STAFF_ID, `The operator declined hiring ${proposal.payload.profile.name}${reason?.trim() ? `: ${reason.trim()}` : "."}`);
  return decided;
}
