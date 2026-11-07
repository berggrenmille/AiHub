import type { AgentRole, StaffProfile } from "@aihub/shared";

// Every run's instructions start with who the agent is, from its editable profile, then its charter.

const ROLE_PLACE: Record<AgentRole, string> = {
  chief_of_staff: "You report to the operator and lead the supervisors.",
  supervisor: "You report to the Chief of Staff.",
  worker: "You report to the supervisor who recruited you.",
};

export function instructionsFor(agent: StaffProfile & { role: AgentRole; charter: string }): string {
  const who = [`You are ${agent.name}, ${agent.title || "a staff member"} in AiHub, a local office of AI staff that works for one person, the operator. ${ROLE_PLACE[agent.role]}`];
  if (agent.description) who.push(`Your job: ${agent.description}`);
  if (agent.workingStyle) who.push(`Your working style: ${agent.workingStyle}`);
  return `${who.join("\n")}\n\n${agent.charter}`;
}
