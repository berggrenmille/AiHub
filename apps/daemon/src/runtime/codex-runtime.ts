import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RateLimitSnapshot } from "@aihub/codex-protocol/v2";
import { AppServerProcess, LOCKED_DOWN_FEATURES, type AppServerCommand } from "./app-server.ts";
import {
  ContextUnavailableError,
  type AgentRuntime,
  type ConnectorRuntime,
  type ContextOptions,
  type ModelOption,
  type RunProfile,
  type RunTurnOptions,
  type RuntimeAccount,
  type RuntimeApp,
  type RuntimeServiceTool,
  type ServiceCallResult,
  type ServiceEndpoint,
  type ServiceInspection,
  type TurnResult,
  type UsageLimits,
} from "./types.ts";

export interface CodexRuntimeOptions {
  /** How to start an app server. Defaults to the project's pinned Codex. Tests pass a fake. */
  command: AppServerCommand;
  /** AiHub's own CODEX_HOME, which holds the sign-in and saved threads. */
  codexHome: string;
  /** Extra environment variables for the app server. */
  env?: NodeJS.ProcessEnv;
}

/** Starts the pinned Codex CLI's app server with every feature in LOCKED_DOWN_FEATURES disabled. */
export function pinnedCodexCommand(root: string): AppServerCommand {
  return {
    command: process.execPath,
    args: [
      join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
      "app-server",
      ...LOCKED_DOWN_FEATURES.flatMap((feature) => ["--disable", feature]),
    ],
  };
}

// Data runs read personal data, so they never share a process with any other run (DESIGN.md › Run profiles).
// The connector process runs with ChatGPT apps on and holds services, and no turn ever runs in it.
type ProcessGroup = "data" | "conversation" | "connector";

/** The server Codex gives ChatGPT apps under. */
const APPS_SERVER = "codex_apps";
/** How long the operator has to finish a sign-in in the browser. */
const SIGN_IN_TIMEOUT_SECS = 600;

/** The same command with ChatGPT apps left on, for the connector process. */
export function withApps(command: AppServerCommand): AppServerCommand {
  const args: string[] = [];
  for (let index = 0; index < command.args.length; index++) {
    if (command.args[index] === "--disable" && command.args[index + 1] === "apps") index++;
    else args.push(command.args[index]!);
  }
  return { command: command.command, args };
}

interface Context {
  group: ProcessGroup;
  options: ContextOptions;
  /** The process the thread is loaded in. A thread must be resumed after its process restarts. */
  loadedIn: AppServerProcess | null;
}

/**
 * AgentRuntime backed by Codex App Server. Data runs and conversation runs each get their own
 * app-server process, started on first use and restarted on the next call after a crash.
 */
export class CodexRuntime implements AgentRuntime {
  private readonly processes = new Map<ProcessGroup, Promise<AppServerProcess>>();
  private readonly contexts = new Map<string, Context>();
  /** The thread each service is called in, by the process it lives in. */
  private readonly serviceThreads = new Map<string, { server: AppServerProcess; threadId: Promise<string> }>();
  private emptyDir: string | null = null;
  private closed = false;
  readonly connectors: ConnectorRuntime;

  constructor(private readonly options: CodexRuntimeOptions) {
    this.connectors = {
      apps: () => this.apps(),
      inspect: (endpoint) => this.inspect(endpoint),
      signIn: (endpoint) => this.signIn(endpoint),
      call: (endpoint, tool, args) => this.callService(endpoint, tool, args),
    };
  }

  async startContext(options: ContextOptions & { ephemeral?: boolean }): Promise<string> {
    const settings = this.threadSettings(options);
    const group = groupOf(options.profile);
    const server = await this.process(group);
    const threadId = await server.startThread(settings, options.tools.map(asDynamicTool), options.ephemeral ?? false);
    this.contexts.set(threadId, { group, options, loadedIn: server });
    return threadId;
  }

  async resumeContext(contextId: string, options: ContextOptions): Promise<void> {
    const settings = this.threadSettings(options);
    const group = groupOf(options.profile);
    const server = await this.process(group);
    try {
      await server.resumeThread(contextId, settings);
    } catch (error) {
      if (!server.running) throw error;
      throw new ContextUnavailableError(contextId, error);
    }
    this.contexts.set(contextId, { group, options, loadedIn: server });
  }

  async runTurn(contextId: string, options: RunTurnOptions): Promise<TurnResult> {
    const context = this.contexts.get(contextId);
    if (!context) throw new ContextUnavailableError(contextId, "it was not started or resumed by this runtime");
    const server = await this.process(context.group);
    if (context.loadedIn !== server) await this.resumeContext(contextId, context.options);
    return server.runTurn(contextId, options);
  }

  async models(): Promise<ModelOption[]> {
    return (await this.process("conversation")).models();
  }

  async account(): Promise<RuntimeAccount> {
    const { account } = await (await this.process("conversation")).account();
    if (account?.type !== "chatgpt") return { signedIn: false, detail: "Not signed in. Run `npm run codex -- login`." };
    return { signedIn: true, detail: `${account.email ?? "unknown email"}, plan ${account.planType}` };
  }

  async usageLimits(): Promise<UsageLimits | null> {
    const { rateLimits } = await (await this.process("conversation")).rateLimits();
    return usageFrom(rateLimits);
  }

  async close(): Promise<void> {
    this.closed = true;
    const servers = await Promise.allSettled(this.processes.values());
    for (const server of servers) if (server.status === "fulfilled") server.value.kill();
    this.processes.clear();
    if (this.emptyDir) rmSync(this.emptyDir, { recursive: true, force: true });
  }

  private async apps(): Promise<RuntimeApp[]> {
    const apps = await (await this.process("connector")).listApps();
    return apps.map((app) => ({ id: app.id, name: app.name, description: app.description, connected: app.isAccessible, connectUrl: app.installUrl }));
  }

  private async inspect(endpoint: ServiceEndpoint): Promise<ServiceInspection> {
    const { server, threadId } = await this.serviceThread(endpoint);
    const status = await server.mcpStatus(threadId, serverOf(endpoint));
    if (!status) return { signedIn: null, tools: [], accounts: [], error: "Codex doesn't list the service." };
    const all = Object.values(status.tools).filter((tool) => tool !== undefined);
    // Every app shares one server, so an app's tools are the ones that name it.
    const tools = endpoint.kind === "app" ? all.filter((tool) => metaOf(tool._meta).connector_id === endpoint.appId) : all;
    const accounts = endpoint.kind === "app" ? accountsOf(tools) : [];
    const signedIn = status.authStatus === "notLoggedIn" ? false : status.authStatus === "oAuth" || status.authStatus === "bearerToken" ? true : null;
    const error = signedIn === false ? null : status.toolsError;
    return { signedIn, tools: tools.map(toServiceTool), accounts, error };
  }

  private async signIn(endpoint: ServiceEndpoint) {
    if (endpoint.kind === "app") throw new Error("An app is connected at ChatGPT, not signed in to here.");
    const { server, threadId } = await this.serviceThread(endpoint);
    return server.oauthLogin(endpoint.server, threadId, SIGN_IN_TIMEOUT_SECS);
  }

  private async callService(endpoint: ServiceEndpoint, tool: string, args: Record<string, unknown>): Promise<ServiceCallResult> {
    const { server, threadId } = await this.serviceThread(endpoint);
    const response = await server.callTool(threadId, serverOf(endpoint), tool, args);
    const text = response.content
      .map((item) => (typeof item === "object" && item !== null && "text" in item ? String((item as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
    return { ok: !response.isError, text, structured: response.structuredContent ?? null };
  }

  /**
   * The connector process's thread for a service, started once and again after the process
   * restarts. Only this thread carries the service's config, so no other thread can reach it.
   */
  private async serviceThread(endpoint: ServiceEndpoint): Promise<{ server: AppServerProcess; threadId: string }> {
    const server = await this.process("connector");
    const key = endpoint.kind === "app" ? APPS_SERVER : JSON.stringify(endpoint);
    let known = this.serviceThreads.get(key);
    if (!known || known.server !== server) {
      this.emptyDir ??= mkdtempSync(join(tmpdir(), "aihub-run-"));
      const config = endpoint.kind === "app" ? {} : { [endpoint.server]: endpoint.kind === "remote_mcp" ? { url: endpoint.url } : { command: endpoint.command, args: endpoint.args } };
      known = { server, threadId: server.startServiceThread(this.emptyDir, config) };
      this.serviceThreads.set(key, known);
      known.threadId.catch(() => {
        if (this.serviceThreads.get(key) === known) this.serviceThreads.delete(key);
      });
    }
    return { server, threadId: await known.threadId };
  }

  private process(group: ProcessGroup): Promise<AppServerProcess> {
    if (this.closed) return Promise.reject(new Error("The Codex runtime is closed"));
    const running = this.processes.get(group);
    if (running) return running;
    const env = { ...process.env, ...this.options.env, CODEX_HOME: this.options.codexHome };
    const forget = () => {
      if (this.processes.get(group) === started) this.processes.delete(group);
    };
    const command = group === "connector" ? withApps(this.options.command) : this.options.command;
    const started = AppServerProcess.start(command, env, forget);
    started.catch(forget);
    this.processes.set(group, started);
    return started;
  }

  /**
   * Data and conversation runs work in an empty directory outside any git repository, so Codex
   * finds no project instructions or config to load. The sandbox is read-only, so it stays empty.
   */
  private threadSettings(options: ContextOptions) {
    if (options.profile === "workspace") throw new Error("Workspace runs arrive in Roadmap phase B");
    this.emptyDir ??= mkdtempSync(join(tmpdir(), "aihub-run-"));
    return { cwd: this.emptyDir, developerInstructions: options.instructions, web: options.web ?? null };
  }
}

function serverOf(endpoint: ServiceEndpoint): string {
  return endpoint.kind === "app" ? APPS_SERVER : endpoint.server;
}

function metaOf(meta: unknown): { connector_id?: string; link_accounts?: Array<{ link_id?: string; link_name?: string }> } {
  return typeof meta === "object" && meta !== null ? (meta as never) : {};
}

/** An app's linked accounts, as its tools list them. */
function accountsOf(tools: Array<{ _meta?: unknown }>): ServiceInspection["accounts"] {
  const accounts = new Map<string, string>();
  for (const tool of tools) {
    for (const account of metaOf(tool._meta).link_accounts ?? []) {
      if (account.link_id) accounts.set(account.link_id, account.link_name || account.link_id);
    }
  }
  return [...accounts].map(([linkId, name]) => ({ linkId, name }));
}

function toServiceTool(tool: { name: string; title?: string; description?: string; inputSchema: unknown; outputSchema?: unknown; annotations?: unknown }): RuntimeServiceTool {
  const labels = typeof tool.annotations === "object" && tool.annotations !== null ? (tool.annotations as Record<string, unknown>) : null;
  const flag = (name: string) => (typeof labels?.[name] === "boolean" ? (labels[name] as boolean) : undefined);
  const annotations = labels ? { readOnlyHint: flag("readOnlyHint"), destructiveHint: flag("destructiveHint"), openWorldHint: flag("openWorldHint") } : null;
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? "",
    annotations: annotations && Object.values(annotations).some((value) => value !== undefined) ? annotations : null,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
  };
}

function groupOf(profile: RunProfile): ProcessGroup {
  return profile === "data" ? "data" : "conversation";
}

function asDynamicTool(tool: ContextOptions["tools"][number]) {
  return { type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/**
 * The plan's usage, from its fullest window: a short one (hours) and a long one (a week) each
 * limit turns, and the fuller one decides when they can run again.
 */
export function usageFrom(snapshot: RateLimitSnapshot): UsageLimits | null {
  const windows = [snapshot.primary, snapshot.secondary].filter((window) => window !== null);
  if (!windows.length) return null;
  const fullest = windows.reduce((a, b) =>
    b.usedPercent > a.usedPercent || (b.usedPercent === a.usedPercent && (b.resetsAt ?? 0) > (a.resetsAt ?? 0)) ? b : a,
  );
  const credits = snapshot.credits?.hasCredits || snapshot.credits?.unlimited;
  return {
    usedPercent: fullest.usedPercent,
    resetsAt: fullest.resetsAt === null ? null : new Date(fullest.resetsAt * 1000),
    exhausted: snapshot.rateLimitReachedType != null || (fullest.usedPercent >= 100 && !credits),
  };
}
