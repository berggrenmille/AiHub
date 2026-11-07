// The runtime interface (DESIGN.md › Architecture). The staff engine talks only to AgentRuntime,
// so Codex can be replaced for some or all runs without changing anything above this layer.
import type { RunProfile } from "@aihub/shared";

export type { RunProfile };

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

export interface ContextOptions {
  profile: RunProfile;
  /** Developer instructions: the agent's charter and standing rules. */
  instructions: string;
  tools: ToolSpec[];
  /** Working directory. Only workspace runs choose one; other profiles get an empty directory. */
  cwd?: string;
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  /** The runtime asked for something AiHub never allows, such as running a command. */
  | { type: "blocked"; what: string };

export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  status: "completed" | "failed" | "interrupted";
  /** The agent's final message. */
  text: string;
  error: string | null;
  usage: TurnUsage | null;
}

export interface RunTurnOptions {
  input: string;
  onToolCall: (call: ToolCall) => Promise<ToolOutcome>;
  onEvent?: (event: TurnEvent) => void;
  timeoutMs?: number;
}

export interface RuntimeAccount {
  signedIn: boolean;
  /** Human-readable description, such as the account email and plan. */
  detail: string;
}

export interface UsageLimits {
  /** Percent of the primary usage window already used. */
  usedPercent: number;
  resetsAt: Date | null;
}

export interface AgentRuntime {
  /** Starts a context and returns its ID. Ephemeral contexts cannot be resumed. */
  startContext(options: ContextOptions & { ephemeral?: boolean }): Promise<string>;
  /** Resumes a saved context. Throws ContextUnavailableError when it cannot. */
  resumeContext(contextId: string, options: ContextOptions): Promise<void>;
  runTurn(contextId: string, options: RunTurnOptions): Promise<TurnResult>;
  account(): Promise<RuntimeAccount>;
  usageLimits(): Promise<UsageLimits | null>;
  close(): Promise<void>;
}

export class ContextUnavailableError extends Error {
  constructor(contextId: string, cause: unknown) {
    super(`Context ${contextId} cannot be resumed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
