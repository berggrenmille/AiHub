import {
  ContextUnavailableError,
  type AgentRuntime,
  type ContextOptions,
  type RunTurnOptions,
  type RuntimeAccount,
  type TurnResult,
  type UsageLimits,
} from "../src/runtime/types.ts";

type Responder = (input: string, options: RunTurnOptions) => Promise<TurnResult>;

/** Echoes the input back in a few streamed pieces. */
export const echo: Responder = async (input, options) => {
  const text = `Echo: ${input}`;
  for (const piece of text.match(/.{1,8}/gs) ?? []) options.onEvent?.({ type: "delta", text: piece });
  return { status: "completed", text, error: null, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } };
};

/** An in-process AgentRuntime for testing the staff engine. Records every call it receives. */
export class FakeRuntime implements AgentRuntime {
  readonly contexts = new Map<string, { options: ContextOptions; inputs: string[] }>();
  readonly calls: string[] = [];
  respond: Responder = echo;
  private nextContext = 1;

  constructor(private readonly prefix = "ctx") {}

  async startContext(options: ContextOptions): Promise<string> {
    const id = `${this.prefix}-${this.nextContext++}`;
    this.contexts.set(id, { options, inputs: [] });
    this.calls.push(`start ${id}`);
    return id;
  }

  /** Resumes contexts this runtime knows, as Codex resumes threads saved in CODEX_HOME. */
  async resumeContext(contextId: string, options: ContextOptions): Promise<void> {
    this.calls.push(`resume ${contextId}`);
    const context = this.contexts.get(contextId);
    if (!context) throw new ContextUnavailableError(contextId, "no saved thread");
    context.options = options;
  }

  async runTurn(contextId: string, options: RunTurnOptions): Promise<TurnResult> {
    this.calls.push(`turn ${contextId}`);
    const context = this.contexts.get(contextId);
    if (!context) throw new ContextUnavailableError(contextId, "not loaded");
    context.inputs.push(options.input);
    return this.respond(options.input, options);
  }

  async account(): Promise<RuntimeAccount> {
    return { signedIn: true, detail: "operator@example.com, plan plus" };
  }

  async usageLimits(): Promise<UsageLimits | null> {
    return { usedPercent: 10, resetsAt: null };
  }

  async close(): Promise<void> {}
}
