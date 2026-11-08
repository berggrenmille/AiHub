import { RUN_KINDS, type AgentRole, type Assignment, type ModelOption, type PolicyVersion, type Proposal, type RecruitProposal, type RunKind, type RunProfile, type StaffChange, type StaffReader } from "@aihub/shared";
import type { StaffChangeRequest } from "../staff/staff-changes.ts";
import type { ReaderFile } from "../sources/reader.ts";
import { z } from "zod";
import type { Notebook } from "../notes/notebook.ts";
import type { ToolCall, ToolOutcome, ToolSpec } from "../runtime/types.ts";
import type { SourceContext } from "../sources/source.ts";
import type { AgentRecord, Store } from "../store/store.ts";
import type { Services } from "../services/services.ts";

/** Who is calling: identified from the active run, never from anything the model says. */
export interface Caller {
  agentId: string;
  runId: string;
  profile: RunProfile;
  /** The run's input holds source data, or reports written from it, even if its profile isn't data. */
  sourceData?: boolean;
}

/** Questions and tasks between staff. Each records an assignment; the asking turn then ends. */
export interface DelegationService {
  ask(caller: Caller, input: { colleague: string; question: string }): Assignment;
  assign(caller: Caller, input: { colleague: string; title: string; deliverable: string; runBudget?: number }): Assignment;
  recruit(caller: Caller, input: { name: string; title: string; description: string; taskTitle: string; task: string; sources: string[] }): Assignment;
  review(caller: Caller, input: { worker: string; verdict: "accept" | "revise"; feedback?: string }): Assignment;
}

/** Readers staff write: the Chief of Staff commissions one, and a toolsmith writes, tests, and hands it in. */
export interface ToolsmithService {
  commission(caller: Caller, input: { name: string; format: string; pattern: string; samples: ReaderFile[]; toolsmith: string }): StaffReader;
  test(caller: Caller, input: { code: string; sample?: ReaderFile }): Promise<string>;
  submit(caller: Caller, input: { code: string; notes: string }): Promise<StaffReader>;
}

/** Views staff write in OpenUI Lang (DESIGN.md › Views). The office checks each one before keeping it. */
export interface ViewService {
  /** The language guide, for a view in a reply or briefing section, or for a dashboard. */
  guide(caller: Caller, kind: "reply" | "dashboard"): string;
  /** A view under the caller's chat reply, or on its briefing section. */
  show(caller: Caller, input: { title: string; program: string }): string;
  /** Saves a dashboard, or a new version of the caller's one with the same title. */
  saveDashboard(caller: Caller, input: { title: string; program: string }): string;
  /** The run read what another staff member or the office holds, so its views hold personal data. */
  tookInPersonal(runId: string): void;
}

/** What tools may ask the office to do. The office checks its rules, records, and publishes each change. */
export interface OfficeServices {
  /** The staff's notes, when the office keeps a vault. */
  notebook: Notebook | null;
  /** Records a recruitment proposal and shows it to the operator as an approval card. */
  proposeSupervisor: ((caller: Caller, proposal: RecruitProposal) => Proposal) | null;
  /** Records a proposed office policy and shows it to the operator as an approval card. */
  proposePolicy: ((caller: Caller, input: { body: string; reason: string }) => PolicyVersion) | null;
  /** Records a proposed change to a supervisor and shows it to the operator as an approval card. */
  proposeStaffChange: ((caller: Caller, input: { supervisor: string; change: StaffChangeRequest; reason: string }) => Promise<StaffChange>) | null;
  /** The models staff can run on. */
  models: (() => Promise<ModelOption[]>) | null;
  delegation: DelegationService | null;
  toolsmith: ToolsmithService | null;
  views: ViewService | null;
  /** What source adapters need from the office for a read. */
  sourceContext: (() => SourceContext) | null;
  /** Services that reach outside accounts, and the calls staff may make on them. */
  services: Services | null;
}

export interface ToolContext extends OfficeServices {
  caller: Caller;
  agent: AgentRecord;
  store: Store;
}

export interface GatewayTool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Input;
  /** Roles that may call the tool. */
  roles: readonly AgentRole[];
  /** Run profiles the tool is offered in. Data runs only ever get tools that cannot act outside AiHub. */
  profiles: readonly RunProfile[];
  /** Run kinds the tool works in, such as no questions from a run that answers one. All but a staff review when omitted. */
  kinds?: readonly RunKind[];
  /** Whether this agent has a use for the tool right now, such as a toolsmith with a reader to write. */
  available?: (agent: AgentRecord, store: Store) => boolean;
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
    private readonly services: Partial<OfficeServices> = {},
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate gateway tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * The tools to offer a run. A chat thread keeps one tool list for every turn, so a chat follow-up
   * is offered tools as a chat run (`asKind`), and the call check refuses what its kind doesn't allow.
   */
  specsFor(caller: Caller, asKind?: RunKind): ToolSpec[] {
    const agent = this.store.getAgentRecord(caller.agentId);
    if (!agent) return [];
    const kind = asKind ?? this.store.getRun(caller.runId)?.kind;
    return [...this.tools.values()]
      .filter((tool) => permits(tool, agent, caller, kind, this.store))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: jsonSchemaOf(tool.input) }));
  }

  /** The tools each kind of run gets for a staff member, for the Access panel. Kinds that get none are left out. */
  toolsByKind(agentId: string): Array<{ kind: RunKind; tools: string[] }> {
    const agent = this.store.getAgentRecord(agentId);
    if (!agent) return [];
    const caller: Caller = { agentId, runId: "", profile: agent.profile };
    return RUN_KINDS.map((kind) => ({ kind, tools: this.specsFor(caller, kind).map((tool) => tool.name) })).filter((entry) => entry.tools.length > 0);
  }

  async call(caller: Caller, call: ToolCall): Promise<ToolOutcome> {
    const tool = this.tools.get(call.name);
    const agent = this.store.getAgentRecord(caller.agentId);
    if (!tool || !agent || !permits(tool, agent, caller, this.store.getRun(caller.runId)?.kind, this.store)) {
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
      const services = {
        notebook: this.services.notebook ?? null,
        proposeSupervisor: this.services.proposeSupervisor ?? null,
        proposePolicy: this.services.proposePolicy ?? null,
        proposeStaffChange: this.services.proposeStaffChange ?? null,
        models: this.services.models ?? null,
        delegation: this.services.delegation ?? null,
        toolsmith: this.services.toolsmith ?? null,
        views: this.services.views ?? null,
        sourceContext: this.services.sourceContext ?? null,
        services: this.services.services ?? null,
      };
      const text = await tool.run(input.data, { caller, agent, store: this.store, ...services });
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

function permits(tool: GatewayTool, agent: AgentRecord, caller: Caller, kind: RunKind | undefined, store: Store): boolean {
  return (
    agent.status === "active" &&
    tool.roles.includes(agent.role) &&
    tool.profiles.includes(caller.profile) &&
    // A staff review gets only the tools that name it: it reads counts, never notes or sources.
    (tool.kinds ? kind !== undefined && tool.kinds.includes(kind) : kind !== "review") &&
    (!tool.available || tool.available(agent, store))
  );
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json;
}
