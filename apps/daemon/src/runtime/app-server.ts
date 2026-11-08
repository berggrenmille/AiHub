import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeResponse, ServerNotification, ServerRequest } from "@aihub/codex-protocol";
import type {
  AppInfo,
  AppsListResponse,
  CodexErrorInfo,
  DynamicToolCallResponse,
  ListMcpServerStatusResponse,
  McpServerOauthLoginResponse,
  McpServerStatus,
  McpServerToolCallResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  Model,
  ModelListResponse,
  ThreadItem,
  ThreadResumeResponse,
  ThreadStartResponse,
  TokenUsageBreakdown,
  Turn,
  TurnStartResponse,
} from "@aihub/codex-protocol/v2";
import { JsonRpcConnection, type ParamsOf, type ServerRequestReply } from "./json-rpc.ts";
import type { ModelOption, RunTurnOptions, TurnBlocker, TurnResult, TurnUsage, WebAccess } from "./types.ts";

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

// "ultra" reasoning hands work to sub-agents Codex starts itself. AiHub turns that off (multi_agent
// above) and delegates through its own staff, so it never offers the level.
const LEVELS_NOT_OFFERED = ["ultra"];

export interface AppServerCommand {
  command: string;
  args: string[];
}

export interface ThreadSettings {
  cwd: string;
  developerInstructions: string;
  web?: WebAccess | null;
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
  /** What the turn runs on. */
  model: TurnResult["model"];
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
  /** What each thread runs on: from its start or resume, then from each turn that names a model. */
  private readonly threadModels = new Map<string, NonNullable<TurnResult["model"]>>();
  private exitReason: string | null = null;
  /** Sign-ins in progress, by service name. */
  private readonly signIns = new Map<string, (outcome: { ok: boolean; error: string | null }) => void>();

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
    if (response.model) this.threadModels.set(response.thread.id, { model: response.model, effort: response.reasoningEffort ?? null });
    return response.thread.id;
  }

  /** Dynamic tools are saved with the thread, so a resumed thread keeps the tools it started with. */
  async resumeThread(threadId: string, settings: ThreadSettings): Promise<void> {
    const response = (await this.connection.request("thread/resume", {
      threadId,
      ...lockedDownThread(settings),
      excludeTurns: true,
    })) as ThreadResumeResponse;
    if (response.model) this.threadModels.set(threadId, { model: response.model, effort: response.reasoningEffort ?? null });
  }

  /** The models this sign-in offers, with the reasoning levels AiHub allows. */
  async models(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const page = (await this.connection.request("model/list", { cursor, includeHidden: false })) as ModelListResponse;
      models.push(...page.data.map(modelOption));
      cursor = page.nextCursor;
    } while (cursor);
    return models;
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
      model: options.model ?? this.threadModels.get(threadId) ?? null,
      latest: null,
      finish,
    };
    this.activeTurns.set(threadId, active);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    try {
      // The model and level apply from this turn on, so a thread follows a staff member's new choice.
      const { turn } = (await this.connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.input, text_elements: [] }],
        ...(options.model ? { model: options.model.model, effort: options.model.effort } : {}),
      })) as TurnStartResponse;
      active.turnId = turn.id;
      if (options.model) this.threadModels.set(threadId, options.model);

      let outcome = await Promise.race([finished, delay(timeoutMs)]);
      if (outcome === "timeout") {
        await this.connection.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => undefined);
        outcome = await Promise.race([finished, delay(INTERRUPT_GRACE_MS)]);
        if (outcome === "timeout" || outcome.status !== "completed") {
          return result(active, "interrupted", `Turn did not finish within ${Math.round(timeoutMs / 1000)}s`);
        }
      }
      const status = outcome.status === "completed" || outcome.status === "interrupted" ? outcome.status : "failed";
      return result(active, status, outcome.error?.message ?? null, blockerOf(outcome.error?.codexErrorInfo ?? null));
    } catch (error) {
      return result(active, "failed", errorText(error));
    } finally {
      this.activeTurns.delete(threadId);
    }
  }

  account(): Promise<GetAccountResponse> {
    return this.connection.request("account/read", { refreshToken: false }) as Promise<GetAccountResponse>;
  }

  // Services (DESIGN.md › Connectors and capabilities). These run only in the connector process,
  // where no turn ever runs: AiHub lists, signs in to, and calls services from code.

  /** A thread that only carries a service's config, for calls from code. No turn runs in it. */
  async startServiceThread(cwd: string, mcpServers: Record<string, unknown>): Promise<string> {
    const response = (await this.connection.request("thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      ephemeral: true,
      config: { web_search: "disabled", ...(Object.keys(mcpServers).length && { mcp_servers: mcpServers }) } as ParamsOf<"thread/start">["config"],
      developerInstructions: "AiHub calls services from code in this thread. No turn runs here.",
    })) as ThreadStartResponse;
    return response.thread.id;
  }

  async listApps(): Promise<AppInfo[]> {
    const apps: AppInfo[] = [];
    let cursor: string | null = null;
    do {
      const page = (await this.connection.request("app/list", { cursor, limit: 500 })) as AppsListResponse;
      apps.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return apps;
  }

  async mcpStatus(threadId: string, serverName: string): Promise<McpServerStatus | null> {
    const page = (await this.connection.request("mcpServerStatus/list", { threadId, serverName, detail: "toolsAndAuthOnly" })) as ListMcpServerStatusResponse;
    return page.data.find((status) => status.name === serverName) ?? null;
  }

  /** Starts a service's sign-in. `done` settles when Codex says it finished, or after the timeout. */
  async oauthLogin(name: string, threadId: string, timeoutSecs: number): Promise<{ url: string; done: Promise<{ ok: boolean; error: string | null }> }> {
    let settle!: (outcome: { ok: boolean; error: string | null }) => void;
    const done = new Promise<{ ok: boolean; error: string | null }>((resolve) => (settle = resolve));
    const timer = setTimeout(() => settle({ ok: false, error: "The sign-in wasn't finished in time." }), (timeoutSecs + 5) * 1000);
    timer.unref?.();
    const listener = (outcome: { ok: boolean; error: string | null }) => {
      clearTimeout(timer);
      settle(outcome);
    };
    this.signIns.set(name, listener);
    try {
      // The generated type says bigint, but the wire takes a plain number, which JSON can carry.
      const response = (await this.connection.request("mcpServer/oauth/login", { name, threadId, timeoutSecs: timeoutSecs as unknown as bigint })) as McpServerOauthLoginResponse;
      return { url: response.authorizationUrl, done: done.finally(() => this.signIns.delete(name)) };
    } catch (error) {
      clearTimeout(timer);
      this.signIns.delete(name);
      throw error;
    }
  }

  async callTool(threadId: string, server: string, tool: string, args: Record<string, unknown>): Promise<McpServerToolCallResponse> {
    return (await this.connection.request("mcpServer/tool/call", {
      threadId,
      server,
      tool,
      arguments: args as ParamsOf<"mcpServer/tool/call">["arguments"],
    })) as McpServerToolCallResponse;
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
        if (active && notification.params.item.type === "webSearch") {
          const { query, action } = notification.params.item;
          const url = action && "url" in action ? action.url : null;
          active.options.onEvent?.({ type: "web", query: query || null, url: url ?? null });
        }
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
      case "mcpServer/oauthLogin/completed": {
        const { name, success, error } = notification.params;
        this.signIns.get(name)?.({ ok: success, error: success ? null : (error ?? "The sign-in failed.") });
        return;
      }
    }
  }

  private handleClose(reason: string) {
    this.exitReason = reason;
    const message = `Codex App Server ${reason}${this.logTail()}`;
    for (const active of this.activeTurns.values()) active.finish({ status: "failed", error: turnError(message) });
    this.onExit(reason);
  }
}

function modelOption(model: Model): ModelOption {
  return {
    id: model.model,
    name: model.displayName,
    description: model.description,
    efforts: model.supportedReasoningEfforts
      .filter((option) => !LEVELS_NOT_OFFERED.includes(option.reasoningEffort))
      .map((option) => ({ effort: option.reasoningEffort, description: option.description })),
    defaultEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  };
}

function lockedDownThread(settings: ThreadSettings) {
  return {
    cwd: settings.cwd,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    config: webConfig(settings.web ?? null),
    developerInstructions: settings.developerInstructions,
  } as const;
}

/** Codex's own web search, off unless the staff member holds it. */
export function webConfig(web: WebAccess | null): ParamsOf<"thread/start">["config"] {
  if (!web) return { web_search: "disabled" };
  // Codex rejects a tool config with empty fields, so one is sent only to limit the sites.
  return web.sites.length ? { web_search: web.mode, tools: { web_search: { allowed_domains: web.sites } } } : { web_search: web.mode };
}

function recordItem(active: ActiveTurn, item: ThreadItem) {
  if (item.type === "agentMessage") active.messages.push({ text: item.text, final: item.phase === "final_answer" });
}

function result(active: ActiveTurn, status: TurnResult["status"], error: string | null, blocker: TurnBlocker | null = null): TurnResult {
  const final = active.messages.findLast((message) => message.final) ?? active.messages.at(-1);
  return { status, text: final?.text ?? "", error, usage: usageOf(active), blocker, model: active.model };
}

/** Sorts a failed turn's cause into what waiting may fix, or null when it won't. */
export function blockerOf(info: CodexErrorInfo | null): TurnBlocker | null {
  if (info === null) return null;
  if (typeof info === "string") {
    if (info === "usageLimitExceeded") return "usage";
    if (info === "unauthorized") return "signed_out";
    if (info === "rateLimitExceeded" || info === "serverOverloaded" || info === "internalServerError") return "busy";
    return null;
  }
  for (const key of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
    const failure = (info as Record<string, unknown>)[key] as { httpStatusCode?: number | null } | undefined;
    if (!failure || typeof failure !== "object") continue;
    const status = failure.httpStatusCode ?? null;
    // No HTTP status means the request never reached the service.
    if (status === null) return "offline";
    if (status === 401) return "signed_out";
    if (status === 429 || status >= 500) return "busy";
    return null;
  }
  return null;
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
