import { describeModel } from "./models.ts";
import type { Proposal, RecruitProposal, SourcePreview } from "@aihub/shared";
import type { Caller } from "../gateway/gateway.ts";
import { SUPERVISOR_LIMIT } from "../limits.ts";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors.ts";
import type { Office } from "../office.ts";
import { checkProposedSource, connectionFor, previewProposedSource, verifyConnection } from "../sources/collect.ts";
import { STAFF_READER_PREFIX } from "../sources/folder.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";
import { SUPERVISOR_CHARTER } from "./supervisor.ts";
import { describeWeb } from "./web.ts";

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
  const named = (proposal: Proposal) => proposal.status === "pending" && proposal.payload.profile.name.toLowerCase() === payload.profile.name.trim().toLowerCase();
  if (store.listProposals(200).some(named)) throw new Error(`A proposal waiting for the operator is already called ${payload.profile.name}. Pick another name.`);
  if (seatsLeft(office) <= 0) {
    throw new Error(`The office is at its cap of ${SUPERVISOR_LIMIT} supervisors, counting pending proposals. Suggest extending an existing responsibility instead.`);
  }
  const proposal = store.createProposal({ proposedBy: caller.agentId, runId: caller.runId, payload });
  bus.publish({ type: "proposal", proposal });
  bus.publish({
    type: "activity",
    entry: store.addActivity({ agentId: caller.agentId, runId: caller.runId, kind: "proposal", summary: `Proposed hiring ${payload.profile.name} as ${payload.profile.title}` }),
  });
  // A staff review posts its cards after its own message, once the run is done.
  if (store.getRun(caller.runId)?.kind !== "review") postRecruitCard(office, proposal, caller.runId);
  return proposal;
}

/** The card for a recruitment proposal, in the Chief of Staff's chat. */
export function postRecruitCard(office: Office, proposal: Proposal, runId: string | null) {
  const { profile, reason } = proposal.payload;
  office.postMessage(CHIEF_OF_STAFF_CONVERSATION_ID, proposal.proposedBy, `Proposal: hire ${profile.name} as ${profile.title}. ${reason}`, runId, "proposal", proposal.id);
}

/** The id of the reader staff wrote that a proposed source uses, if it uses one. */
function staffReaderOf(proposal: Proposal): string | null {
  const reader = proposal.payload.source?.reader;
  return reader?.startsWith(STAFF_READER_PREFIX) ? reader.slice(STAFF_READER_PREFIX.length) : null;
}

/** What the proposed source would read at the path the operator typed, before they approve. */
export async function previewProposal(office: Office, id: string, sourcePath: string): Promise<SourcePreview> {
  const proposal = office.store.getProposal(id);
  if (!proposal) throw new NotFoundError(`No proposal ${id}`);
  const { source } = proposal.payload;
  if (!source) throw new InvalidRequestError("This proposal has no source to preview.");
  const path = sourcePath.trim().replace(/^"(.*)"$/, "$1");
  if (!path) throw new InvalidRequestError(`Pick the ${source.kind === "folder" ? "folder" : "file"} for ${source.label} first.`);
  const readerId = staffReaderOf(proposal);
  const code = readerId ? (office.store.getReader(readerId)?.code ?? null) : null;
  try {
    return { ...(await previewProposedSource(source, path, office.candidateSourceContext())), code };
  } catch (error) {
    throw new InvalidRequestError(`AiHub can't read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The operator approves: hire the supervisor with its responsibility, routine, and access. */
export async function approveProposal(office: Office, id: string, options: { sourcePath?: string } = {}): Promise<Proposal> {
  const { store, bus, notebook } = office;
  const proposal = store.getProposal(id);
  if (!proposal) throw new NotFoundError(`No proposal ${id}`);
  if (proposal.status !== "pending") throw new ConflictError(`This proposal was already ${proposal.status}.`);
  const { profile, responsibility: duty, source, web = null, model = null } = proposal.payload;
  // The caps are checked again: the office may have changed since the proposal was made.
  if (store.isNameTaken(profile.name)) throw new ConflictError(`Someone on staff is already called ${profile.name}.`);
  if (SUPERVISOR_LIMIT - store.countActive("supervisor") <= 0) throw new ConflictError(`The office is at its cap of ${SUPERVISOR_LIMIT} supervisors.`);

  const sourcePath = options.sourcePath?.trim().replace(/^"(.*)"$/, "$1");
  const what = source?.kind === "folder" ? "folder" : "file";
  if (source && !sourcePath) throw new InvalidRequestError(`Pick the ${what} for ${source.label} to approve this proposal.`);
  const readerId = staffReaderOf(proposal);
  if (readerId) {
    const reader = store.getReader(readerId);
    if (reader?.status !== "proposed" && reader?.status !== "approved") throw new ConflictError(`The reader this source needs isn't ready: it is ${reader?.status ?? "gone"}.`);
  }
  if (source && sourcePath) {
    // Read the source before hiring anyone, so a wrong path is fixed on the card, not after. A reader
    // staff wrote runs here, in the sandbox, before its approval: approving means having seen this.
    try {
      await checkProposedSource(source, sourcePath, office.candidateSourceContext());
    } catch (error) {
      throw new InvalidRequestError(`AiHub can't read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Another approval may have run while the source was read.
  if (store.getProposal(id)?.status !== "pending") throw new ConflictError("This proposal was already decided.");

  const hired = store.transaction(() => {
    const agentId = store.freeAgentId(profile.name);
    // The card showed a look seeded from the proposed name, so the hire keeps that look.
    store.upsertAgent({
      id: agentId,
      ...profile,
      avatar: profile.name,
      role: "supervisor",
      managerId: CHIEF_OF_STAFF_ID,
      profile: "data",
      charter: SUPERVISOR_CHARTER,
      model: model?.id ?? null,
      effort: model?.effort ?? null,
    });
    const responsibility = store.createResponsibility({ ownerId: agentId, ...duty });
    const routine = store.createRoutine({
      ownerId: agentId,
      responsibilityId: responsibility.id,
      title: `${responsibility.title} for the briefing`,
      trigger: { type: "briefing" },
      timezone: "Europe/Stockholm",
      dailyTurnBudget: SUPERVISOR_DAILY_TURNS,
    });
    const connection = source && sourcePath ? store.createConnection(connectionFor(source, sourcePath)) : null;
    if (connection) store.grant(agentId, connection.id, ["read"]);
    if (web) store.setWebGrant(agentId, web);
    const decided = store.decideProposal(id, "approved", `Hired ${profile.name} as ${profile.title}.`)!;
    return { agentId, responsibility, routine, connection, decided };
  });
  // The operator approved the reader with the supervisor, so its code is pinned from now on.
  if (readerId) office.toolsmith.approve(readerId);

  const connection = hired.connection ? await verifyConnection(store, hired.connection.id, office.sourceContext()) : null;
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
  const searches = web ? ` ${profile.name} has ${describeWeb(web)}.` : "";
  const runsOn = model ? ` ${profile.name} runs on ${describeModel({ model: model.id, effort: model.effort }, office.knownModels())}.` : "";
  office.postMessage(
    CHIEF_OF_STAFF_CONVERSATION_ID,
    CHIEF_OF_STAFF_ID,
    `${profile.name} joined as ${profile.title} and reports in the next morning briefing.${access}${searches}${runsOn}`,
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
