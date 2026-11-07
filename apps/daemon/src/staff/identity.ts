import type { AgentRole, Responsibility, StaffProfile } from "@aihub/shared";
import { NOTES_GUIDANCE } from "../notes/notebook.ts";

// Every run's instructions start with who the agent is, from its editable profile, then its charter.

const ROLE_PLACE: Record<AgentRole, string> = {
  chief_of_staff: "You report to the operator and lead the supervisors.",
  supervisor: "You report to the Chief of Staff.",
  worker: "You report to the supervisor who recruited you.",
};

/**
 * Who the agent is, its charter, and its responsibility. Standing instructions come from the
 * operator, who alone changes them, so they belong here and not in notes.
 */
export function instructionsFor(agent: StaffProfile & { role: AgentRole; charter: string }, responsibility: Responsibility | null = null): string {
  const who = [`You are ${agent.name}, ${agent.title || "a staff member"} in AiHub, a local office of AI staff that works for one person, the operator. ${ROLE_PLACE[agent.role]}`];
  if (agent.description) who.push(`Your job: ${agent.description}`);
  if (agent.workingStyle) who.push(`Your working style: ${agent.workingStyle}`);
  const duty: string[] = [];
  if (responsibility) {
    duty.push(`Your responsibility: ${responsibility.title}.${responsibility.scope ? ` ${responsibility.scope}` : ""}`);
    if (responsibility.standingInstructions) duty.push(`Standing instructions from the operator: ${responsibility.standingInstructions}`);
    if (responsibility.expiresAt) duty.push(`It ends at ${responsibility.expiresAt}.`);
  }
  return [who.join("\n"), duty.join("\n"), agent.charter, NOTES_GUIDANCE].filter(Boolean).join("\n\n");
}
