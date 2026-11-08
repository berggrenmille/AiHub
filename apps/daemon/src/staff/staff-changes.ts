import type { ProposedModel, ProposedOperation, Responsibility, StaffChange, StaffChangeDetail, StaffProfile } from "@aihub/shared";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors.ts";
import type { Caller } from "../gateway/gateway.ts";
import type { Office } from "../office.ts";
import { allowedBy, callsOn, leftOutSentence } from "../services/catalog.ts";
import type { AgentRecord } from "../store/store.ts";
import { CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";
import { describeModel, modelChoiceProblem } from "./models.ts";
import { SUPERVISOR_CHARTER } from "./supervisor.ts";

// Staff changes (DESIGN.md › Staff review): the Chief of Staff proposes changing a supervisor's
// instructions or model, letting it call more operations on a service, ending its responsibility, or
// replacing it, from her review of the staff or when the operator asks in chat. Each waits on a card, and nothing changes until the operator
// approves it, against the supervisor and responsibility as they were when it was proposed.

/** A review proposes at most this many changes. */
export const CHANGES_PER_REVIEW = 3;

/** A change as the Chief of Staff asks for it. */
export type StaffChangeRequest =
  | { kind: "instructions"; scope?: string; standingInstructions?: string }
  | { kind: "model"; model: ProposedModel }
  | { kind: "end" }
  | { kind: "replace"; profile: StaffProfile; model: ProposedModel | null }
  | { kind: "operations"; operations: Array<{ service: string; operation: string; why: string }> };

/** The active supervisor called `name`, with the responsibility it works on. Throws with a reason the model can act on. */
function supervisorNamed(office: Office, name: string): { agent: AgentRecord; responsibility: Responsibility } {
  const { store } = office;
  const supervisors = store.listAgents().filter((agent) => agent.role === "supervisor");
  const found = supervisors.find((agent) => agent.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) {
    const names = supervisors.map((agent) => agent.name).join(", ");
    throw new Error(`There is no supervisor called ${name}.${names ? ` The supervisors: ${names}.` : " The office has no supervisors."}`);
  }
  const responsibility = store.activeResponsibilityOf(found.id);
  if (!responsibility) throw new Error(`${found.name}'s responsibility has already ended.`);
  return { agent: store.getAgentRecord(found.id)!, responsibility };
}

/** Called by the Chief of Staff's tool. A newer change for the same supervisor replaces one still waiting. */
export async function proposeStaffChange(office: Office, caller: Caller, input: { supervisor: string; change: StaffChangeRequest; reason: string }): Promise<StaffChange> {
  const { store, bus } = office;
  const { agent, responsibility } = supervisorNamed(office, input.supervisor);
  const inReview = store.getRun(caller.runId)?.kind === "review";
  // More access comes only from the operator asking for it, never from the numbers.
  if (inReview && input.change.kind === "operations") throw new Error("A staff review doesn't add operations. The operator asks for those in chat.");
  if (inReview && store.staffChangesOfRun(caller.runId).length >= CHANGES_PER_REVIEW) {
    throw new Error(`A review proposes at most ${CHANGES_PER_REVIEW} changes. Keep the most useful ones.`);
  }
  const change = await detailOf(office, agent, responsibility, input.change);
  const { proposed, replaced } = store.transaction(() => {
    const replaced = store.pendingStaffChanges(agent.id).flatMap((pending) => store.decideStaffChange(pending.id, "withdrawn", "Replaced by a newer proposal.") ?? []);
    const proposed = store.createStaffChange({
      agentId: agent.id,
      agentName: agent.name,
      responsibilityId: responsibility.id,
      change,
      reason: input.reason,
      proposedBy: caller.agentId,
      runId: caller.runId,
      fromSourceData: caller.sourceData === true,
    });
    return { proposed, replaced };
  });
  for (const withdrawn of [...replaced, proposed]) bus.publish({ type: "staff_change", change: withdrawn });
  bus.publish({
    type: "activity",
    entry: store.addActivity({ agentId: caller.agentId, runId: caller.runId, kind: "proposal", summary: `Proposed: ${headline(proposed)}` }),
  });
  // A staff review posts its cards after its own message, once the run is done.
  if (!inReview) postStaffChangeCard(office, proposed);
  return proposed;
}

/** Checks a requested change against the office as it is now, and records what it changes from. */
async function detailOf(office: Office, agent: AgentRecord, responsibility: Responsibility, request: StaffChangeRequest): Promise<StaffChangeDetail> {
  const { store } = office;
  switch (request.kind) {
    case "instructions": {
      const scope = request.scope ?? responsibility.scope;
      const standingInstructions = request.standingInstructions ?? responsibility.standingInstructions;
      if (scope === responsibility.scope && standingInstructions === responsibility.standingInstructions) {
        throw new Error("That is the responsibility as it stands. Give the new scope or standing instructions.");
      }
      return { kind: "instructions", scope, standingInstructions, before: { scope: responsibility.scope, standingInstructions: responsibility.standingInstructions } };
    }
    case "model": {
      await checkModel(office, request.model);
      if (request.model.id === agent.model && request.model.effort === agent.effort) throw new Error(`${agent.name} already runs on that.`);
      return { kind: "model", model: request.model, before: { model: agent.model, effort: agent.effort } };
    }
    case "end":
      return { kind: "end" };
    case "replace": {
      const name = request.profile.name.trim();
      if (store.isNameTaken(name)) throw new Error(`Someone on staff is already called ${name}. Pick another name.`);
      const waiting = [
        ...store.listProposals(200).flatMap((proposal) => (proposal.status === "pending" ? [proposal.payload.profile.name] : [])),
        ...store.pendingStaffChanges().flatMap((pending) => (pending.change.kind === "replace" && pending.agentId !== agent.id ? [pending.change.profile.name] : [])),
      ];
      if (waiting.some((taken) => taken.toLowerCase() === name.toLowerCase())) throw new Error(`A proposal waiting for the operator is already called ${name}. Pick another name.`);
      if (request.model) await checkModel(office, request.model);
      return { kind: "replace", profile: { ...request.profile, name }, model: request.model };
    }
    case "operations": {
      // AiHub words each risk, so an unsafe operation carries its sentence onto the card.
      const planned = office.services.planAccess(agent.name, { operations: request.operations });
      const held = planned.operations.filter((operation) => store.serviceGrantFor(agent.id, operation.serviceId, operation.operation));
      const operations = planned.operations.filter((operation) => !held.includes(operation));
      if (!operations.length) throw new Error(`${agent.name} may already call ${callList(held)}.`);
      return { kind: "operations", operations, unsafe: office.services.operationGrants(agent.name, operations) };
    }
  }
}

/** Operations as a list, such as "search_messages on Work mail, send_message on Work mail". */
function callList(operations: ProposedOperation[]): string {
  return callsOn(operations);
}

async function checkModel(office: Office, model: ProposedModel) {
  const problem = modelChoiceProblem(await office.models(), { model: model.id, effort: model.effort });
  if (problem) throw new Error(`${problem} See aihub_list_models.`);
}

/** What a change does, in a few words, such as "replace Nora with Ada". */
export function headline(change: StaffChange): string {
  const { agentName: name, responsibilityTitle: title } = change;
  switch (change.change.kind) {
    case "instructions":
      return `new instructions for ${name}'s ${title}`;
    case "model":
      return `run ${name} on ${change.change.model.id}, ${change.change.model.effort} reasoning`;
    case "end":
      return `end ${name}'s ${title}`;
    case "replace":
      return `replace ${name} with ${change.change.profile.name}`;
    case "operations":
      return `let ${name} call ${callList(change.change.operations)}`;
  }
}

/** The card for a staff change, in the Chief of Staff's chat. */
export function postStaffChangeCard(office: Office, change: StaffChange) {
  const text = `Proposal: ${headline(change)}. ${change.reason}`;
  office.postMessage(office.cardChat(change.runId), change.proposedBy, text, change.runId, "staff_change", String(change.id), change.fromSourceData);
}

/**
 * The operator approves a change. It applies to the supervisor and responsibility only as they were
 * when proposed. `ticked` holds the unsafe grants the operator ticked: an unticked one is left out.
 */
export async function approveStaffChange(office: Office, id: number, ticked: string[] = []): Promise<StaffChange> {
  const { store } = office;
  const proposed = store.getStaffChange(id);
  if (!proposed) throw new NotFoundError(`No staff change ${id}`);
  if (proposed.status !== "pending") throw new ConflictError(`This proposal was already ${proposed.status}.`);
  const agent = store.getAgent(proposed.agentId);
  if (!agent) throw new ConflictError(`${proposed.agentName} has left the office.`);
  const responsibility = store.getResponsibility(proposed.responsibilityId);
  if (!responsibility || !store.isResponsibilityActive(responsibility.id) || responsibility.ownerId !== agent.id) {
    throw new ConflictError(`${proposed.agentName}'s ${proposed.responsibilityTitle} has changed since this was proposed. Ask for a new proposal.`);
  }
  const { change } = proposed;
  if (change.kind === "end" || change.kind === "replace") {
    if (agent.state !== "idle" && agent.state !== "waiting_for_access") throw new ConflictError(`${agent.name} is working right now. Approve this once the run is done.`);
    const open = store.countAssignments({ ownerId: agent.id, statuses: ["open", "waiting"] });
    if (open) throw new ConflictError(`${agent.name} still has ${open} open question${open === 1 ? "" : "s"} or task${open === 1 ? "" : "s"}. Approve this once they are done.`);
  }
  if (change.kind === "replace" && store.isNameTaken(change.profile.name)) throw new ConflictError(`Someone on staff is already called ${change.profile.name}.`);
  if (change.kind === "instructions" && (responsibility.scope !== change.before.scope || responsibility.standingInstructions !== change.before.standingInstructions)) {
    throw new ConflictError(`${proposed.responsibilityTitle} has new instructions since this was proposed. Ask for a new proposal.`);
  }
  if (change.kind === "model") {
    if (agent.model !== change.before.model || agent.effort !== change.before.effort) {
      throw new ConflictError(`${agent.name}'s model changed since this was proposed. Ask for a new proposal.`);
    }
    // Checks the catalog before anything is decided, so a model Codex no longer offers is refused here.
    const problem = modelChoiceProblem(await office.models(), { model: change.model.id, effort: change.model.effort });
    if (problem) throw new ConflictError(problem);
  }
  const access = change.kind === "operations" ? accessOf(office, change, new Set(ticked)) : { granted: [], leftOut: [] };
  // Another decision may have come in while the catalog was read.
  if (store.getStaffChange(id)?.status !== "pending") throw new ConflictError("This proposal was already decided.");

  const outcome = await apply(office, proposed, agent.id, responsibility, access);
  const approved = store.decideStaffChange(id, "approved", outcome)!;
  office.bus.publish({ type: "staff_change", change: approved });
  office.bus.publish({ type: "activity", entry: store.addActivity({ agentId: agent.id, runId: null, kind: "approved", summary: `The operator approved: ${headline(approved)}` }) });
  office.notebook.journal(CHIEF_OF_STAFF_ID, `The operator approved my proposal to ${headline(approved)}.`);
  office.postMessage(office.chatOfCard("staff_change", String(id)), CHIEF_OF_STAFF_ID, `You approved: ${outcome}`, null, "notice", String(id));
  return approved;
}

/** What an operations change grants with the operator's ticks, and what it leaves out. Throws when it would grant nothing. */
function accessOf(office: Office, change: Extract<StaffChangeDetail, { kind: "operations" }>, ticked: ReadonlySet<string>): { granted: ProposedOperation[]; leftOut: ProposedOperation[] } {
  const granted = change.operations.filter((operation) => allowedBy(operation, ticked));
  if (!granted.length) throw new InvalidRequestError("Every operation here is unsafe and none is ticked. Tick the ones you allow, or decline.");
  for (const serviceId of new Set(granted.map((operation) => operation.serviceId))) {
    const service = office.store.getService(serviceId);
    if (!service || !["connected", "signed_out", "failed"].includes(service.status)) {
      throw new ConflictError(`${service?.name ?? "A service this proposal uses"} is no longer in use. Ask the Chief of Staff for a new proposal.`);
    }
  }
  return { granted, leftOut: change.operations.filter((operation) => !granted.includes(operation)) };
}

/** Makes the change and says what it did. */
async function apply(
  office: Office,
  proposed: StaffChange,
  agentId: string,
  responsibility: Responsibility,
  access: { granted: ProposedOperation[]; leftOut: ProposedOperation[] },
): Promise<string> {
  const { store, bus, notebook } = office;
  const { change, agentName: name } = proposed;
  switch (change.kind) {
    case "instructions": {
      const updated = store.setResponsibilityText(responsibility.id, { scope: change.scope, standingInstructions: change.standingInstructions })!;
      bus.publish({ type: "responsibility", responsibility: updated });
      notebook.syncProfile(agentId);
      notebook.journal(agentId, `The operator approved new instructions for ${updated.title}. I work from them from my next run.`);
      return `${name} works on ${updated.title} with the new instructions from the next run.`;
    }
    case "model": {
      await office.setModel(agentId, { model: change.model.id, effort: change.model.effort });
      return `${name} runs on ${describeModel({ model: change.model.id, effort: change.model.effort }, office.knownModels())} from the next run.`;
    }
    case "end": {
      office.endResponsibility(responsibility.id);
      leave(office, agentId, `${name} left the office: ${responsibility.title} ended`, proposed.id);
      return `${responsibility.title} ended and ${name} left the office. Their items and notes stay.`;
    }
    case "replace": {
      const old = store.getAgentRecord(agentId)!;
      const { profile } = change;
      const newId = store.transaction(() => {
        const id = store.freeAgentId(profile.name);
        store.upsertAgent({
          id,
          ...profile,
          avatar: profile.name,
          role: "supervisor",
          managerId: CHIEF_OF_STAFF_ID,
          profile: "data",
          charter: SUPERVISOR_CHARTER,
          model: change.model ? change.model.id : old.model,
          effort: change.model ? change.model.effort : old.effort,
        });
        store.handOver(agentId, id, responsibility.id);
        return id;
      });
      notebook.syncProfile(newId);
      bus.publish({ type: "responsibility", responsibility: store.getResponsibility(responsibility.id)! });
      for (const routine of store.listRoutines()) if (routine.responsibilityId === responsibility.id) bus.publish({ type: "routine", routine });
      bus.publish({ type: "agent", agent: store.getAgent(newId)! });
      notebook.journal(newId, `I took over ${responsibility.title} from [[${name}]].`);
      leave(office, agentId, `${profile.name} took over ${responsibility.title} from ${name}, who left the office`, proposed.id);
      return `${profile.name} took over ${responsibility.title} from ${name}, with the same sources and items, and reports in the next briefing. ${name} left the office.`;
    }
    case "operations": {
      const { granted, leftOut } = access;
      store.transaction(() => {
        for (const operation of granted) store.grantOperation(agentId, operation.serviceId, operation.operation, operation.unsafe);
      });
      office.services.publishGrants();
      for (const operation of granted.filter((one) => one.unsafe)) {
        bus.publish({
          type: "activity",
          entry: store.addActivity({ agentId, runId: null, kind: "service", summary: `Unsafe: the operator let ${name} call ${operation.operation} on ${operation.serviceName}` }),
        });
      }
      notebook.journal(agentId, `The operator let me call ${callList(granted)}, with aihub_use_service.`);
      return `${name} may call ${callsOn(granted, { markUnsafe: true })} from the next run.${leftOutSentence(leftOut)}`;
    }
  }
}

/** A supervisor leaves: archived with its access revoked. Its records and notes stay. Its other waiting changes are withdrawn. */
function leave(office: Office, agentId: string, summary: string, approving: number) {
  const { store, bus, notebook } = office;
  store.archiveAgent(agentId);
  notebook.syncProfile(agentId);
  bus.publish({ type: "agent_left", agentId });
  withdrawStaffChanges(office, agentId, "They left the office.", approving);
  const chief = store.getAgent(CHIEF_OF_STAFF_ID);
  if (chief) bus.publish({ type: "agent", agent: chief });
  bus.publish({ type: "office", office: office.officeStats() });
  bus.publish({ type: "activity", entry: store.addActivity({ agentId, runId: null, kind: "approved", summary }) });
}

/** Withdraws the changes still waiting for a supervisor, such as one whose responsibility ended. */
export function withdrawStaffChanges(office: Office, agentId: string, reason: string, except?: number) {
  for (const pending of office.store.pendingStaffChanges(agentId)) {
    if (pending.id === except) continue;
    const withdrawn = office.store.decideStaffChange(pending.id, "withdrawn", reason);
    if (withdrawn) office.bus.publish({ type: "staff_change", change: withdrawn });
  }
}

/** The operator declines a change, optionally saying why. */
export function declineStaffChange(office: Office, id: number, reason: string | null = null): StaffChange {
  const { store, bus, notebook } = office;
  const proposed = store.getStaffChange(id);
  if (!proposed) throw new NotFoundError(`No staff change ${id}`);
  const declined = store.decideStaffChange(id, "declined", reason || "Declined by the operator.");
  if (!declined) throw new ConflictError(`This proposal was already ${proposed.status}.`);
  bus.publish({ type: "staff_change", change: declined });
  bus.publish({ type: "activity", entry: store.addActivity({ agentId: declined.agentId, runId: null, kind: "declined", summary: `The operator declined: ${headline(declined)}` }) });
  const why = reason ? `: ${reason}` : ".";
  notebook.journal(CHIEF_OF_STAFF_ID, `The operator declined my proposal to ${headline(declined)}${why}`);
  office.postMessage(office.chatOfCard("staff_change", String(id)), CHIEF_OF_STAFF_ID, `You declined the proposal to ${headline(declined)}${why}`, null, "notice", String(id));
  return declined;
}
