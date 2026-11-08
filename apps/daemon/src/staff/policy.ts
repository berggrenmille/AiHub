import type { PolicyVersion } from "@aihub/shared";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors.ts";
import type { Caller } from "../gateway/gateway.ts";
import type { Office } from "../office.ts";
import { CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";

// The office policy (DESIGN.md › Memory and notes): the operator's rules for every staff member, in
// every run's instructions. Unlike a note it carries authority, so only the operator changes it. The
// Chief of Staff can propose a new version, which applies once the operator approves its card: her
// chat takes in briefings and answers written from source data, so an instruction injected there
// could otherwise become a rule for the whole staff.

export const POLICY_LIMIT = 4000;

function cleaned(body: string): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text.length > POLICY_LIMIT) throw new InvalidRequestError(`The policy can be at most ${POLICY_LIMIT} characters; this is ${text.length}.`);
  return text;
}

/** The operator writes the policy, which applies from each staff member's next run. Waiting proposals are withdrawn. */
export function writePolicy(office: Office, body: string): PolicyVersion {
  const { store, bus } = office;
  const text = cleaned(body);
  const current = store.currentPolicy();
  if (text === (current?.body ?? "")) throw new InvalidRequestError("That's the policy already.");
  const { version, withdrawn } = store.transaction(() => {
    const withdrawn = store.pendingPolicies().flatMap((pending) => store.decidePolicy(pending.id, "withdrawn", "You changed the policy yourself after this was proposed.") ?? []);
    const version = store.addPolicy({ body: text, authorId: null, reason: null, basedOn: current?.id ?? null, status: "approved", fromSourceData: false });
    return { version, withdrawn };
  });
  for (const policy of [...withdrawn, version]) bus.publish({ type: "policy", policy });
  const summary = text ? "The operator changed the office policy" : "The operator cleared the office policy";
  bus.publish({ type: "activity", entry: store.addActivity({ agentId: null, runId: null, kind: "policy", summary }) });
  return version;
}

/** The Chief of Staff proposes a whole new policy. An earlier proposal still waiting is replaced. Throws with a reason the model can act on. */
export function proposePolicy(office: Office, caller: Caller, input: { body: string; reason: string }): PolicyVersion {
  const { store, bus } = office;
  const text = cleaned(input.body);
  const current = store.currentPolicy();
  if (text === (current?.body ?? "")) throw new Error("That is the current policy word for word. Propose only a change.");
  const { proposal, replaced } = store.transaction(() => {
    const replaced = store.pendingPolicies().flatMap((pending) => store.decidePolicy(pending.id, "withdrawn", "Replaced by a newer proposal.") ?? []);
    const proposal = store.addPolicy({
      body: text,
      authorId: caller.agentId,
      reason: input.reason,
      basedOn: current?.id ?? null,
      status: "pending",
      fromSourceData: caller.sourceData === true,
    });
    return { proposal, replaced };
  });
  for (const policy of [...replaced, proposal]) bus.publish({ type: "policy", policy });
  bus.publish({
    type: "activity",
    entry: store.addActivity({ agentId: caller.agentId, runId: caller.runId, kind: "policy", summary: "Proposed a change to the office policy" }),
  });
  office.postMessage(office.cardChat(caller.runId), caller.agentId, `Policy proposal: ${input.reason}`, caller.runId, "policy", String(proposal.id), caller.sourceData === true);
  return proposal;
}

/** The operator approves a proposal. It must change the policy as it stands now. */
export function approvePolicy(office: Office, id: number): PolicyVersion {
  const { store, bus, notebook } = office;
  const proposal = store.getPolicy(id);
  if (!proposal) throw new NotFoundError(`No policy proposal ${id}`);
  if (proposal.status !== "pending") throw new ConflictError(`This proposal was already ${proposal.status}.`);
  if ((store.currentPolicy()?.id ?? null) !== proposal.basedOn) throw new ConflictError("The policy changed since this was proposed. Ask for a new proposal.");
  const approved = store.decidePolicy(id, "approved", null);
  if (!approved) throw new ConflictError("This proposal was already decided.");
  bus.publish({ type: "policy", policy: approved });
  bus.publish({ type: "activity", entry: store.addActivity({ agentId: approved.authorId, runId: null, kind: "policy", summary: "The operator approved the new office policy" }) });
  if (approved.authorId) notebook.journal(approved.authorId, "The operator approved my proposed office policy.");
  office.postMessage(office.chatOfCard("policy", String(id)), CHIEF_OF_STAFF_ID, "You approved the new office policy. Every staff member works under it from their next run.", null, "notice", String(id));
  return approved;
}

/** The operator declines a proposal, optionally saying why. */
export function declinePolicy(office: Office, id: number, reason: string | null = null): PolicyVersion {
  const { store, bus, notebook } = office;
  const proposal = store.getPolicy(id);
  if (!proposal) throw new NotFoundError(`No policy proposal ${id}`);
  const declined = store.decidePolicy(id, "declined", reason);
  if (!declined) throw new ConflictError(`This proposal was already ${proposal.status}.`);
  bus.publish({ type: "policy", policy: declined });
  bus.publish({ type: "activity", entry: store.addActivity({ agentId: declined.authorId, runId: null, kind: "policy", summary: "The operator declined a change to the office policy" }) });
  const why = reason ? `: ${reason}` : ".";
  if (declined.authorId) notebook.journal(declined.authorId, `The operator declined my proposed office policy${why}`);
  office.postMessage(office.chatOfCard("policy", String(id)), CHIEF_OF_STAFF_ID, `You declined the policy proposal${why}`, null, "notice", String(id));
  return declined;
}
