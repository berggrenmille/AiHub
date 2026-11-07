import type { AgentRole, RunProfile } from "@aihub/shared";
import { z } from "zod";
import type { Notebook } from "../notes/notebook.ts";
import type { ToolCall, ToolOutcome, ToolSpec } from "../runtime/types.ts";
import type { AgentRecord, Store } from "../store/store.ts";

/** Who is calling: identified from the active run, never from anything the model says. */
export interface Caller {
  agentId: string;
  runId: string;
  profile: RunProfile;
  /** The run's input holds source data, or reports written from it, even if its profile isn't data. */
  sourceData?: boolean;
}

export interface ToolContext {
  caller: Caller;
  agent: AgentRecord;
  store: Store;
  /** The staff's notes, when the office keeps a vault. */
  notebook: Notebook | null;
}

export interface GatewayTool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Input;
  /** Roles that may call the tool. */
  roles: readonly AgentRole[];
  /** Run profiles the tool is offered in. Data runs only ever get tools that cannot act outside AiHub. */
  profiles: readonly RunProfile[];
  run: (input: z.output<Input>, context: ToolContext) => string | Promise<string>;
}

export function defineTool<Input extends z.ZodType>(tool: GatewayTool<Input>): GatewayTool {
  return tool as unknown as GatewayTool;
}

/**
 * The tool and policy gateway (DESIGN.md › Architecture). Offers each run only the tools its
 * agent and profile allow, and checks the caller again and validates the arguments on every call.
 */
export class Gateway {
  private readonly tools = new Map<string, GatewayTool>();

  constructor(
    private readonly store: Store,
    tools: GatewayTool[],
    private readonly onActivity: (entry: ReturnType<Store["addActivity"]>) => void = () => {},
    private readonly notebook: Notebook | null = null,
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate gateway tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  /** The tools to offer a run. */
  specsFor(caller: Caller): ToolSpec[] {
    const agent = this.store.getAgentRecord(caller.agentId);
    if (!agent) return [];
    return [...this.tools.values()]
      .filter((tool) => permits(tool, agent, caller))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: jsonSchemaOf(tool.input) }));
  }

  async call(caller: Caller, call: ToolCall): Promise<ToolOutcome> {
    const tool = this.tools.get(call.name);
    const agent = this.store.getAgentRecord(caller.agentId);
    if (!tool || !agent || !permits(tool, agent, caller)) {
      return this.refuse(caller, call.name, `${call.name} is not available to this run.`);
    }
    // A run under an ended or expired responsibility, such as a mandate, can do nothing more.
    const run = this.store.getRun(caller.runId);
    if (run?.responsibilityId && !this.store.isResponsibilityActive(run.responsibilityId)) {
      return this.refuse(caller, call.name, "The responsibility this run works under has ended, so no further actions are allowed under it.");
    }
    const input = tool.input.safeParse(call.arguments ?? {});
    if (!input.success) {
      return this.refuse(caller, call.name, `Invalid arguments for ${call.name}: ${z.prettifyError(input.error)}`);
    }
    try {
      const text = await tool.run(input.data, { caller, agent, store: this.store, notebook: this.notebook });
      this.record(caller, "tool_call", `Used ${call.name}`, { tool: call.name, arguments: input.data });
      return { ok: true, text };
    } catch (error) {
      return this.refuse(caller, call.name, `${call.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private refuse(caller: Caller, tool: string, reason: string): ToolOutcome {
    this.record(caller, "tool_refused", `Refused ${tool}`, { tool, reason });
    return { ok: false, text: reason };
  }

  private record(caller: Caller, kind: "tool_call" | "tool_refused", summary: string, detail: unknown) {
    this.onActivity(this.store.addActivity({ agentId: caller.agentId, runId: caller.runId, kind, summary, detail }));
  }
}

function permits(tool: GatewayTool, agent: AgentRecord, caller: Caller): boolean {
  return agent.status === "active" && tool.roles.includes(agent.role) && tool.profiles.includes(caller.profile);
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json;
}
