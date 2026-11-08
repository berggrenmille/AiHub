import { z } from "zod";
import type { ToolSpec } from "@openuidev/lang-core";

// The data a dashboard can fetch (DESIGN.md › Views). Each tool only reads AiHub's records: what
// the staff found, their runs and usage, the roster, their assignments, and the operator's sources
// through the same readers staff use. None acts. The daemon answers them for the operator's page,
// which can see everything in the office anyway; the staff member who wrote the dashboard never sees
// what they return.

const staff = z.string().trim().min(1).max(40).optional().describe("A staff member's name. Everyone when left out.");
const days = (most: number, what: string) => z.number().int().min(1).max(most).optional().describe(what);

const ItemsInput = z
  .object({
    staff,
    states: z
      .array(z.enum(["new", "open", "resolved", "dismissed"]))
      .optional()
      .describe('Which states to include. ["new", "open"] when left out.'),
    days: days(365, "Only items first seen in the last this many days."),
    needsOperator: z
      .boolean()
      .optional()
      .describe("true: only items the operator has to act on, as the Inbox shows. false: only items worth knowing, such as news. Both when left out."),
    limit: z.number().int().min(1).max(500).optional().describe("Most rows, newest first. 100 when left out."),
  })
  .strict();

const RunsInput = z
  .object({
    staff,
    kind: z.enum(["chat", "briefing", "report", "question", "assignment", "follow_up", "review"]).optional(),
    days: days(90, "Runs from the last this many days. 7 when left out."),
    limit: z.number().int().min(1).max(1_000).optional().describe("Most rows, newest first. 200 when left out."),
  })
  .strict();

const UsageInput = z.object({ days: days(90, "How many days back, today included. 14 when left out.") }).strict();

const StaffInput = z.object({}).strict();

const AssignmentsInput = z
  .object({
    staff,
    days: days(365, "Assignments created in the last this many days. 30 when left out."),
    limit: z.number().int().min(1).max(500).optional().describe("Most rows, newest first. 100 when left out."),
  })
  .strict();

const SourceInput = z
  .object({
    source: z.string().trim().min(1).max(60).describe('A source\'s name, such as "Work calendar", from office_staff.'),
    from: z.iso.date().optional().describe("For a calendar: the first day, YYYY-MM-DD. Today when left out."),
    days: z.number().int().min(1).max(31).optional().describe("For a calendar: how many days. 7 when left out."),
    words: z.string().trim().max(200).optional().describe("Only records containing all of these words."),
    limit: z.number().int().min(1).max(200).optional().describe("Most records. 50 when left out."),
  })
  .strict();

const text = { type: "string" };
const number = { type: "number" };
const textOrNull = { type: ["string", "null"] };
const iso = { type: "string", description: "ISO date and time; show it with @Time." };
const isoOrNull = { type: ["string", "null"], description: "ISO date and time; show it with @Time." };

function rows(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: fields } } } };
}

export const DATA_TOOLS = {
  office_items: {
    description:
      "What the staff found and reported, newest first: items the operator has to act on, which wait in the Inbox until resolved or dismissed, and items only worth knowing, such as news, which lapse after a couple of days.",
    input: ItemsInput,
    output: rows({
      id: number,
      title: text,
      detail: text,
      urgency: { type: "string", enum: ["urgent", "today", "this_week", "fyi"] },
      needsOperator: { type: "boolean", description: "The operator has to act on it; it shows in the Inbox." },
      state: { type: "string", enum: ["new", "open", "resolved", "dismissed"] },
      staff: text,
      responsibility: text,
      firstSeenAt: iso,
      updatedAt: iso,
      resolution: textOrNull,
    }),
  },
  office_runs: {
    description: "The staff's runs: what each did, when, how it ended, and the usage and model it ran on. Newest first.",
    input: RunsInput,
    output: rows({
      id: text,
      staff: text,
      kind: text,
      title: text,
      state: { type: "string", description: "done, failed, or still in progress such as working." },
      queuedAt: iso,
      finishedAt: isoOrNull,
      turns: number,
      inputTokens: number,
      cachedInputTokens: number,
      outputTokens: number,
      model: textOrNull,
      effort: textOrNull,
      error: textOrNull,
    }),
  },
  office_usage: {
    description: "Usage per day in the operator's time zone, oldest first: runs, model turns, and tokens.",
    input: UsageInput,
    output: rows({ day: { type: "string", description: "YYYY-MM-DD" }, runs: number, turns: number, inputTokens: number, cachedInputTokens: number, outputTokens: number }),
  },
  office_staff: {
    description: "The roster: each staff member with their role, responsibility, state, sources, web search, and model.",
    input: StaffInput,
    output: rows({
      name: text,
      title: text,
      role: text,
      manager: textOrNull,
      responsibility: textOrNull,
      state: text,
      sources: { type: "array", items: text },
      webSearch: { type: "boolean" },
      model: { type: "string", description: "Its model, or office default." },
      experience: number,
    }),
  },
  office_assignments: {
    description: "Questions and tasks between staff, newest first.",
    input: AssignmentsInput,
    output: rows({
      id: text,
      kind: { type: "string", enum: ["question", "task"] },
      title: text,
      requester: text,
      owner: text,
      status: text,
      createdAt: iso,
      updatedAt: iso,
      result: textOrNull,
    }),
  },
  source_records: {
    description:
      "Reads one of the operator's sources now, as staff do. A calendar gives its events in a window; a folder gives one record per entry, with fields that depend on its reader.",
    input: SourceInput,
    output: {
      type: "object",
      properties: {
        summary: text,
        events: {
          type: "array",
          description: "For a calendar.",
          items: { type: "object", properties: { title: text, start: iso, end: iso, allDay: { type: "boolean" }, location: textOrNull, status: text } },
        },
        records: { type: "array", description: "For a folder.", items: { type: "object" } },
      },
    },
  },
} as const;

export type DataToolName = keyof typeof DATA_TOOLS;

export const DATA_TOOL_NAMES = Object.keys(DATA_TOOLS) as DataToolName[];

export type DataToolInput<N extends DataToolName> = z.output<(typeof DATA_TOOLS)[N]["input"]>;

export function isDataTool(name: string): name is DataToolName {
  return Object.hasOwn(DATA_TOOLS, name);
}

/** The data tools as the language guide lists them. */
export function dataToolSpecs(): ToolSpec[] {
  return DATA_TOOL_NAMES.map((name) => {
    const tool = DATA_TOOLS[name];
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
    return { name, description: tool.description, inputSchema, outputSchema: tool.output, annotations: { readOnlyHint: true } };
  });
}
