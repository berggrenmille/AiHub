// The runtime interface (DESIGN.md › Architecture). The staff engine talks only to AgentRuntime,
// so Codex can be replaced for some or all runs without changing anything above this layer.
import type { ModelOption, RunProfile } from "@aihub/shared";

export type { ModelOption, RunProfile };

/** The model and reasoning level for a turn. */
export interface ModelSetting {
  model: string;
  effort: string;
}

/** A gateway tool offered to the model. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: unknown;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text returned to the model. */
  text: string;
}

/**
 * Web search for a run (DESIGN.md › Authority and data boundaries). "indexed" answers from the
 * search service's own copy of the web and fetches nothing from the sites; "live" fetches pages
 * from the sites themselves.
 */
export interface WebAccess {
  mode: "cached" | "indexed" | "live";
  /** Limits search to these sites, such as "bbc.com". Empty allows any. */
  sites: string[];
}

export interface ContextOptions {
  profile: RunProfile;
  /** Developer instructions: the agent's charter and standing rules. */
  instructions: string;
  tools: ToolSpec[];
  /** Working directory. Only workspace runs choose one; other profiles get an empty directory. */
  cwd?: string;
  /** Web search, when the staff member holds it. Off when left out. */
  web?: WebAccess | null;
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  /** The runtime asked for something AiHub never allows, such as running a command. */
  | { type: "blocked"; what: string }
  /** The run searched the web or opened a page. */
  | { type: "web"; query: string | null; url: string | null };

export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Why a turn couldn't run, when waiting may fix it: the plan's usage is used up, Codex is signed
 * out, there is no connection, or the service is busy. Any other failure has no blocker.
 */
export type TurnBlocker = "usage" | "signed_out" | "offline" | "busy";

export interface TurnResult {
  status: "completed" | "failed" | "interrupted";
  /** The agent's final message. */
  text: string;
  error: string | null;
  usage: TurnUsage | null;
  /** Set when the turn failed for a reason waiting may fix. */
  blocker?: TurnBlocker | null;
  /** What the turn ran on, when the runtime says. A null effort is the model's default. */
  model?: { model: string; effort: string | null } | null;
}

export interface RunTurnOptions {
  input: string;
  onToolCall: (call: ToolCall) => Promise<ToolOutcome>;
  onEvent?: (event: TurnEvent) => void;
  timeoutMs?: number;
  /** The model and reasoning level for this turn. The runtime's default when left out. */
  model?: ModelSetting | null;
}

export interface RuntimeAccount {
  signedIn: boolean;
  /** Human-readable description, such as the account email and plan. */
  detail: string;
}

export interface UsageLimits {
  /** Percent used of the plan's fullest usage window. */
  usedPercent: number;
  /** When that window resets. */
  resetsAt: Date | null;
  /** The plan can't run a turn until the window resets. */
  exhausted?: boolean;
}

export interface AgentRuntime {
  /** Starts a context and returns its ID. Ephemeral contexts cannot be resumed. */
  startContext(options: ContextOptions & { ephemeral?: boolean }): Promise<string>;
  /** Resumes a saved context. Throws ContextUnavailableError when it cannot. */
  resumeContext(contextId: string, options: ContextOptions): Promise<void>;
  runTurn(contextId: string, options: RunTurnOptions): Promise<TurnResult>;
  /** The models runs can use. */
  models(): Promise<ModelOption[]>;
  account(): Promise<RuntimeAccount>;
  usageLimits(): Promise<UsageLimits | null>;
  close(): Promise<void>;
}

export class ContextUnavailableError extends Error {
  constructor(contextId: string, cause: unknown) {
    super(`Context ${contextId} cannot be resumed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
