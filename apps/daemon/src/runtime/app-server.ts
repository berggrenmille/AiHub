import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeResponse, ServerNotification, ServerRequest } from "@aihub/codex-protocol";
import type {
  DynamicToolCallResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  ThreadItem,
  ThreadResumeResponse,
  ThreadStartResponse,
  TokenUsageBreakdown,
  Turn,
  TurnStartResponse,
} from "@aihub/codex-protocol/v2";
import { JsonRpcConnection, type ParamsOf, type ServerRequestReply } from "./json-rpc.ts";
import type { RunTurnOptions, TurnResult, TurnUsage } from "./types.ts";

// Codex features that give a run a way around the gateway: ChatGPT apps (the codex_apps MCP server,
// which includes web search), browser and computer use, shell and file-viewing tools, and anything
// that installs or suggests new tools. Features apply to the whole app-server process, so every
// process AiHub starts has them disabled (spikes/codex-app-server/README.md).
export const LOCKED_DOWN_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "shell_tool",
  "unified_exec",
  "view_image",
];

export interface AppServerCommand {
  command: string;
  args: string[];
}

export interface ThreadSettings {
  cwd: string;
  developerInstructions: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
/** How long to wait for Codex to confirm an interrupt before reporting the turn as interrupted anyway. */
const INTERRUPT_GRACE_MS = 5_000;

interface ActiveTurn {
  turnId: string | null;
  options: RunTurnOptions;
  messages: Array<{ text: string; final: boolean }>;
  /** Thread token total before this turn's first model request. */
  baseline: TokenUsageBreakdown | null;
  latest: TokenUsageBreakdown | null;
  finish: (turn: Pick<Turn, "status" | "error">) => void;
}

/**
 * One Codex App Server child process. Turns are routed by thread ID, and each thread runs one turn
 * at a time, so notifications that arrive before `turn/start` returns still reach the right turn.
 */
export class AppServerProcess {
  private readonly connection: JsonRpcConnection;
  private readonly child;
  private readonly stderrTail: string[] = [];
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** Last token total Codex reported for each thread, to measure the next turn against. */
  private readonly threadTotals = new Map<string, TokenUsageBreakdown>();
  private exitReason: string | null = null;

  private constructor(
    command: AppServerCommand,
    env: NodeJS.ProcessEnv,
    private readonly onExit: (reason: string) => void,
  ) {
    this.child = spawn(command.command, command.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.connection = new JsonRpcConnection(this.child, {
      onServerRequest: (request) => this.handleServerRequest(request),
      onNotification: (notification) => this.handleNotification(notification),
      onClose: (reason) => this.handleClose(reason),
    });
  }

  static async start(
    command: AppServerCommand,
    env: NodeJS.ProcessEnv,
    onExit: (reason: string) => void,
  ): Promise<AppServerProcess> {
    const server = new AppServerProcess(command, env, onExit);
    try {
      (await server.connection.request("initialize", {
        clientInfo: { name: "aihub", title: "AiHub", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })) as InitializeResponse;
      server.connection.notify("initialized");
      return server;
    } catch (error) {
      server.kill();
      throw new Error(`Codex App Server did not start: ${errorText(error)}${server.logTail()}`);
    }
  }

  get running(): boolean {
    return this.exitReason === null;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async startThread(settings: ThreadSettings, tools: unknown[], ephemeral: boolean): Promise<string> {
    const response = (await this.connection.request("thread/start", {
      ...lockedDownThread(settings),
      ephemeral,
      dynamicTools: tools as ParamsOf<"thread/start">["dynamicTools"],
    })) as ThreadStartResponse;
    return response.thread.id;
  }

  /** Dynamic tools are saved with the thread, so a resumed thread keeps the tools it started with. */
  async resumeThread(threadId: string, settings: ThreadSettings): Promise<void> {
    (await this.connection.request("thread/resume", {
      threadId,
      ...lockedDownThread(settings),
      excludeTurns: true,
    })) as ThreadResumeResponse;
  }

  async runTurn(threadId: string, options: RunTurnOptions): Promise<TurnResult> {
    if (this.activeTurns.has(threadId)) throw new Error(`Thread ${threadId} already has a turn running`);

    let finish!: ActiveTurn["finish"];
    const finished = new Promise<Pick<Turn, "status" | "error">>((resolve) => (finish = resolve));
    const active: ActiveTurn = {
      turnId: null,
      options,
      messages: [],
      baseline: this.threadTotals.get(threadId) ?? null,
      latest: null,
      finish,
    };
    this.activeTurns.set(threadId, active);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    try {
      const { turn } = (await this.connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.input, text_elements: [] }],
      })) as TurnStartResponse;
      active.turnId = turn.id;

      let outcome = await Promise.race([finished, delay(timeoutMs)]);
      if (outcome === "timeout") {
        await this.connection.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => undefined);
        outcome = await Promise.race([finished, delay(INTERRUPT_GRACE_MS)]);
        if (outcome === "timeout" || outcome.status !== "completed") {
          return result(active, "interrupted", `Turn did not finish within ${Math.round(timeoutMs / 1000)}s`);
        }
      }
      const status = outcome.status === "completed" || outcome.status === "interrupted" ? outcome.status : "failed";
      return result(active, status, outcome.error?.message ?? null);
    } catch (error) {
      return result(active, "failed", errorText(error));
    } finally {
      this.activeTurns.delete(threadId);
    }
  }

  account(): Promise<GetAccountResponse> {
    return this.connection.request("account/read", { refreshToken: false }) as Promise<GetAccountResponse>;
  }

  rateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.connection.request("account/rateLimits/read", undefined) as Promise<GetAccountRateLimitsResponse>;
  }

  kill() {
    this.child.kill();
  }

  logTail(): string {
    return this.stderrTail.length ? `\nLast Codex log lines:\n${this.stderrTail.join("\n")}` : "";
  }

  private async handleServerRequest(request: ServerRequest): Promise<ServerRequestReply> {
    switch (request.method) {
      case "item/tool/call": {
        const active = this.activeTurns.get(request.params.threadId);
        const call = { name: request.params.tool, arguments: request.params.arguments };
        if (!active) return toolReply(false, `No AiHub turn is running for tool ${call.name}`);
        active.options.onEvent?.({ type: "tool_call", ...call });
        try {
          const outcome = await active.options.onToolCall(call);
          return toolReply(outcome.ok, outcome.text);
        } catch (error) {
          return toolReply(false, `Tool ${call.name} failed: ${errorText(error)}`);
        }
      }
      case "item/commandExecution/requestApproval":
        this.block(request.params.threadId, `run a command: ${request.params.command ?? "(not given)"}`);
        return { result: { decision: "decline" } };
      case "item/fileChange/requestApproval":
        this.block(request.params.threadId, "change files");
        return { result: { decision: "decline" } };
      case "execCommandApproval":
      case "applyPatchApproval":
        this.block(request.params.conversationId, request.method);
        return { result: { decision: { denied: { rejection: "AiHub does not allow this." } } } };
      default: {
        // Permission escalations, user-input prompts, MCP elicitations, and anything newer are refused.
        const threadId = (request.params as { threadId?: string } | undefined)?.threadId;
        if (threadId) this.block(threadId, request.method);
        return { error: { code: -32000, message: `AiHub does not allow ${request.method}` } };
      }
    }
  }

  private block(threadId: string, what: string) {
    this.activeTurns.get(threadId)?.options.onEvent?.({ type: "blocked", what });
  }

  private handleNotification(notification: ServerNotification) {
    switch (notification.method) {
      case "item/agentMessage/delta":
        this.activeTurns.get(notification.params.threadId)?.options.onEvent?.({ type: "delta", text: notification.params.delta });
        return;
      case "item/completed": {
        const active = this.activeTurns.get(notification.params.threadId);
        if (active) recordItem(active, notification.params.item);
        return;
      }
      case "thread/tokenUsage/updated": {
        const { threadId, tokenUsage } = notification.params;
        this.threadTotals.set(threadId, tokenUsage.total);
        const active = this.activeTurns.get(threadId);
        if (active) {
          // A thread resumed in this process has no known total yet. Its first report covers
          // one model request, so the total before the turn is that report's total minus it.
          active.baseline ??= subtract(tokenUsage.total, tokenUsage.last);
          active.latest = tokenUsage.total;
        }
        return;
      }
      case "turn/completed":
        this.activeTurns.get(notification.params.threadId)?.finish(notification.params.turn);
        return;
    }
  }

  private handleClose(reason: string) {
    this.exitReason = reason;
    const message = `Codex App Server ${reason}${this.logTail()}`;
    for (const active of this.activeTurns.values()) active.finish({ status: "failed", error: turnError(message) });
    this.onExit(reason);
  }
}

function lockedDownThread(settings: ThreadSettings) {
  return {
    cwd: settings.cwd,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    config: { web_search: "disabled" },
    developerInstructions: settings.developerInstructions,
  } as const;
}

function recordItem(active: ActiveTurn, item: ThreadItem) {
  if (item.type === "agentMessage") active.messages.push({ text: item.text, final: item.phase === "final_answer" });
}

function result(active: ActiveTurn, status: TurnResult["status"], error: string | null): TurnResult {
  const final = active.messages.findLast((message) => message.final) ?? active.messages.at(-1);
  return { status, text: final?.text ?? "", error, usage: usageOf(active) };
}

function usageOf(active: ActiveTurn): TurnUsage | null {
  if (!active.latest) return null;
  const spent = active.baseline ? subtract(active.latest, active.baseline) : active.latest;
  return { inputTokens: spent.inputTokens, cachedInputTokens: spent.cachedInputTokens, outputTokens: spent.outputTokens };
}

function subtract(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: a.totalTokens - b.totalTokens,
    inputTokens: a.inputTokens - b.inputTokens,
    cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
  };
}

function toolReply(success: boolean, text: string): ServerRequestReply {
  const result: DynamicToolCallResponse = { success, contentItems: [{ type: "inputText", text }] };
  return { result };
}

function turnError(message: string): Turn["error"] {
  return { message, codexErrorInfo: null, additionalDetails: null, misalignment: null };
}

/** Resolves to "timeout" after `ms` without keeping the process alive. */
function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms).unref());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
