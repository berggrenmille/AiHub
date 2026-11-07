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

export const ReportInput = z
  .object({
    summary: z.string().trim().min(1).max(600).describe("One or two sentences for the operator's briefing."),
    items: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            detail: z.string().max(1000).describe("What happened and what it means for the operator."),
            urgency: z.enum(["urgent", "today", "this_week", "fyi"]).describe("urgent: needs action within hours."),
            sourceRef: z.string().max(200).describe("The id of the source record this item comes from."),
          })
          .strict(),
      )
      .max(20),
    decisionsNeeded: z.array(z.string().max(300)).max(10).default([]).describe("Questions only the operator can answer."),
  })
  .strict();

// The only way a data run can affect anything: it files one report, which AiHub stores as data.
export const submitReport = defineTool({
  name: "aihub_submit_report",
  description: "File your report for this run. Call it exactly once. AiHub stores it and the Chief of Staff reads it.",
  input: ReportInput,
  roles: ["supervisor", "worker"],
  profiles: ["data"],
  run: (report, { caller, store }) => {
    const stored = store.addResult({ runId: caller.runId, agentId: caller.agentId, summary: report.summary, body: report });
    if (!stored) throw new Error("A report was already filed for this run");
    return "Report filed.";
  },
});

export const OFFICE_TOOLS: GatewayTool[] = [getRoster, listActivity, submitReport];
