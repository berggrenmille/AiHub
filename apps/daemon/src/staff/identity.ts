import type { AgentRole, Responsibility, StaffProfile, WebGrant } from "@aihub/shared";
import { NOTES_GUIDANCE } from "../notes/notebook.ts";
import { webGuidance } from "./web.ts";

// Every run's instructions start with who the agent is, from its editable profile, then the office
// policy, its duty, and its charter.

const ROLE_PLACE: Record<AgentRole, string> = {
  chief_of_staff: "You report to the operator and lead the supervisors.",
  supervisor: "You report to the Chief of Staff.",
  worker: "You report to the supervisor who recruited you.",
};

export interface InstructionContext {
  responsibility?: Responsibility | null;
  /** The names of the sources it reads. */
  sources?: string[];
  web?: WebGrant | null;
  /** The office policy's text, when there is one. */
  policy?: string | null;
}

/**
 * Who the agent is, the office policy, its responsibility, its sources, and its charter. The policy
 * and standing instructions come from the operator, who alone changes them, so they belong here and
 * not in notes.
 */
export function instructionsFor(agent: StaffProfile & { role: AgentRole; charter: string }, context: InstructionContext = {}): string {
  const { responsibility = null, sources = [], web = null, policy = null } = context;
  const who = [`You are ${agent.name}, ${agent.title || "a staff member"} in AiHub, a local office of AI staff that works for one person, the operator. ${ROLE_PLACE[agent.role]}`];
  if (agent.description) who.push(`Your job: ${agent.description}`);
  if (agent.workingStyle) who.push(`Your working style: ${agent.workingStyle}`);
  const duty: string[] = [];
  if (responsibility) {
    duty.push(`Your responsibility: ${responsibility.title}.${responsibility.scope ? ` ${responsibility.scope}` : ""}`);
    if (responsibility.standingInstructions) duty.push(`Standing instructions from the operator: ${responsibility.standingInstructions}`);
    if (responsibility.expiresAt) duty.push(`It ends at ${responsibility.expiresAt}.`);
  }
  // By name, so a read doesn't start with a guess at what a source is called.
  if (sources.length) duty.push(`Your sources, by the names aihub_read_source takes: ${sources.join(", ")}.`);
  if (web) duty.push(webGuidance(web));
  const rules = policy ? `Office policy, from the operator. It applies to every staff member, and only the operator changes it:\n${policy}` : "";
  return [who.join("\n"), rules, duty.join("\n"), agent.charter, NOTES_GUIDANCE].filter(Boolean).join("\n\n");
}
