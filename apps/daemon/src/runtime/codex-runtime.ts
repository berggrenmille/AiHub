import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RateLimitSnapshot } from "@aihub/codex-protocol/v2";
import { AppServerProcess, LOCKED_DOWN_FEATURES, type AppServerCommand } from "./app-server.ts";
import {
  ContextUnavailableError,
  type AgentRuntime,
  type ContextOptions,
  type RunProfile,
  type RunTurnOptions,
  type RuntimeAccount,
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
type ProcessGroup = "data" | "conversation";

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
  private emptyDir: string | null = null;
  private closed = false;

  constructor(private readonly options: CodexRuntimeOptions) {}

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

  private process(group: ProcessGroup): Promise<AppServerProcess> {
    if (this.closed) return Promise.reject(new Error("The Codex runtime is closed"));
    const running = this.processes.get(group);
    if (running) return running;
    const env = { ...process.env, ...this.options.env, CODEX_HOME: this.options.codexHome };
    const forget = () => {
      if (this.processes.get(group) === started) this.processes.delete(group);
    };
    const started = AppServerProcess.start(this.options.command, env, forget);
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
    return { cwd: this.emptyDir, developerInstructions: options.instructions };
  }
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
