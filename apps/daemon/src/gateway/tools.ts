import { z } from "zod";
import { defineTool, type GatewayTool } from "./gateway.ts";

// Read-only office tools for Milestone 1. Each tool names who may call it; the gateway enforces that.

export const getRoster = defineTool({
  name: "aihub_get_roster",
  description: "List the AiHub staff with each member's role, manager, and current run state.",
  input: z.object({}).strict(),
  roles: ["chief_of_staff"],
  profiles: ["conversation"],
  run: (_input, { store }) => {
    const agents = store.listAgents();
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    return JSON.stringify(
      agents.map((agent) => ({
        name: agent.name,
        role: agent.role,
        manager: agent.managerId ? (names.get(agent.managerId) ?? null) : null,
        state: agent.state,
      })),
    );
  },
});

export const listActivity = defineTool({
  name: "aihub_list_activity",
  description: "List recent activity in the office, newest first: runs started and finished, tools used, and anything refused or blocked.",
  input: z
    .object({ limit: z.number().int().min(1).max(50).default(20).describe("How many entries to return.") })
    .strict(),
  roles: ["chief_of_staff"],
  profiles: ["conversation"],
  run: ({ limit }, { store }) => {
    const agents = new Map(store.listAgents().map((agent) => [agent.id, agent.name]));
    return JSON.stringify(
      store.recentActivity(limit).map((entry) => ({
        at: entry.at,
        who: entry.agentId ? (agents.get(entry.agentId) ?? entry.agentId) : "AiHub",
        what: entry.summary,
      })),
    );
  },
});

export const OFFICE_TOOLS: GatewayTool[] = [getRoster, listActivity];
