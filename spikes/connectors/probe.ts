// Milestone 6 probe: how can AiHub reach an outside account through Codex? See README.md in this folder.
//
// Part A runs a made-up mail service (an MCP server behind OAuth) and a local MCP program, against
// Codex with a throwaway CODEX_HOME, so it needs no sign-in and spends no usage. Part B reads which
// ChatGPT apps AiHub's own Codex sign-in offers, and calls one only when asked. No model turn runs anywhere.
//
//   npm run spike:connectors            both parts
//   npm run spike:connectors -- --mcp   Part A only
//   npm run spike:connectors -- --apps  Part B only
//   npm run spike:connectors -- --apps --call-app=<tool> --args=<json>
//                                       Part B, plus one call to an app's tool. Pick one that reads public data.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ClientRequest, RequestId } from "@aihub/codex-protocol";
import type {
  AppsListResponse,
  ListMcpServerStatusResponse,
  McpServerOauthLoginResponse,
  McpServerStatus,
  McpServerToolCallResponse,
  ThreadStartResponse,
} from "@aihub/codex-protocol/v2";
import { startTestService, type TestService } from "./test-service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const codexJs = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");

// The same list as apps/daemon/src/runtime/app-server.ts.
const LOCKED_DOWN_FEATURES = [
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

type ParamsOf<M extends ClientRequest["method"]> = Extract<ClientRequest, { method: M }>["params"];
type Message = { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { message: string } };

/** One app-server process, with every server request and notification kept for the report. */
class AppServer {
  readonly notifications: Message[] = [];
  readonly serverRequests: Message[] = [];
  private readonly pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly waiters: Array<{ match: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  private readonly stderr: string[] = [];
  private nextId = 1;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 60) this.stderr.shift();
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as Message;
      if (message.method === undefined && message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      } else if (message.id !== undefined) {
        this.serverRequests.push(message);
        this.answer(message);
      } else {
        this.notifications.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    });
    child.on("exit", (code) => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`app-server exited with code ${code}`));
      this.pending.clear();
    });
  }

  static async start(codexHome: string, disabled: string[]): Promise<AppServer> {
    const child = spawn(process.execPath, [codexJs, "app-server", ...disabled.flatMap((feature) => ["--disable", feature])], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const server = new AppServer(child);
    await server.request("initialize", {
      clientInfo: { name: "aihub_probe", title: "AiHub connector probe", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return server;
  }

  request<M extends ClientRequest["method"]>(method: M, params: ParamsOf<M>, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
    });
  }

  waitFor(match: (message: Message) => boolean, timeoutMs = 30_000): Promise<Message> {
    const seen = this.notifications.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a notification")), timeoutMs);
      this.waiters.push({ match, resolve: (message) => (clearTimeout(timer), resolve(message)) });
    });
  }

  /** Declines everything Codex asks, as AiHub does. */
  private answer(message: Message) {
    const result =
      message.method === "mcpServer/elicitation/request"
        ? { action: "decline", content: null, _meta: null }
        : message.method?.endsWith("requestApproval") || message.method?.endsWith("Approval")
          ? { decision: "decline" }
          : null;
    if (result) this.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
    else this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Not handled by the probe" } })}\n`);
  }

  logTail(): string {
    return this.stderr.slice(-15).join("\n");
  }

  kill() {
    this.child.kill();
  }
}

// ---------------------------------------------------------------------------
// The report

const findings: Array<{ question: string; answer: string }> = [];
function finding(question: string, answer: string) {
  findings.push({ question, answer });
  console.log(`\n■ ${question}\n  ${answer.replace(/\n/g, "\n  ")}`);
}
function step(text: string) {
  console.log(`  · ${text}`);
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startThread(server: AppServer, cwd: string, config: Record<string, unknown> = {}): Promise<string> {
  const response = (await server.request("thread/start", {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    ephemeral: true,
    config: { web_search: "disabled", ...config } as ParamsOf<"thread/start">["config"],
    developerInstructions: "Probe thread. No turn runs here.",
  })) as ThreadStartResponse;
  return response.thread.id;
}

async function statuses(server: AppServer, threadId: string | null, serverName?: string): Promise<McpServerStatus[]> {
  const out: McpServerStatus[] = [];
  let cursor: string | null = null;
  do {
    const page = (await server.request("mcpServerStatus/list", { cursor, threadId, detail: "toolsAndAuthOnly", ...(serverName ? { serverName } : {}) })) as ListMcpServerStatusResponse;
    out.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

function describeStatus(status: McpServerStatus): string {
  const tools = Object.values(status.tools).filter((tool) => tool !== undefined);
  const labels = tools.map((tool) => `${tool.name}${tool.annotations ? ` ${JSON.stringify(tool.annotations)}` : " (no annotations)"}`);
  return `${status.name}: auth ${status.authStatus}, runtime ${status.runtimeStatus ?? "none"}, origin ${status.httpOrigin ?? "none"}${status.toolsError ? `, tools error: ${status.toolsError}` : ""}${labels.length ? `\n    ${labels.join("\n    ")}` : ""}`;
}

function call(server: AppServer, threadId: string, name: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  return callWithMeta(server, threadId, name, tool, args);
}

async function callWithMeta(server: AppServer, threadId: string, name: string, tool: string, args: Record<string, unknown>, meta?: unknown): Promise<string> {
  try {
    const response = (await server.request("mcpServer/tool/call", {
      threadId,
      server: name,
      tool,
      arguments: args as ParamsOf<"mcpServer/tool/call">["arguments"],
      ...(meta === undefined ? {} : { _meta: meta as ParamsOf<"mcpServer/tool/call">["_meta"] }),
    })) as McpServerToolCallResponse;
    const text = response.content.map((item) => (item as { text?: string }).text ?? JSON.stringify(item)).join(" ");
    return `${response.isError ? "error: " : ""}${text}${response.structuredContent !== undefined ? ` [structured]` : ""}`;
  } catch (error) {
    return `refused: ${errorText(error)}`;
  }
}

/** Signs a service in, playing the operator's browser: open the address and follow the redirect back to Codex. */
async function signIn(server: AppServer, service: TestService, name: string, threadId: string, as: string): Promise<string> {
  service.signInAs(as);
  const started = (await server.request("mcpServer/oauth/login", { name, threadId })) as McpServerOauthLoginResponse;
  step(`${name}: sign-in address ${new URL(started.authorizationUrl).origin}${new URL(started.authorizationUrl).pathname}`);
  const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
  const callback = authorize.headers.get("location");
  if (!callback) return `no redirect from the authorize page (${authorize.status})`;
  step(`${name}: redirect back to ${new URL(callback).origin}${new URL(callback).pathname}`);
  await fetch(callback).catch((error) => step(`callback fetch: ${errorText(error)}`));
  const done = await server.waitFor(
    (message) => message.method === "mcpServer/oauthLogin/completed" && (message.params as { name?: string }).name === name,
    30_000,
  );
  const params = done.params as { success: boolean; error?: string };
  return params.success ? "signed in" : `sign-in failed: ${params.error}`;
}

function credentialManagerEntries(): string[] {
  if (process.platform !== "win32") return [];
  const listed = spawnSync("cmdkey", ["/list"], { encoding: "utf8" });
  return (listed.stdout ?? "").split(/\r?\n/).filter((line) => /codex|mcp/i.test(line)).map((line) => line.trim());
}

// ---------------------------------------------------------------------------
// Part A: MCP servers, with a throwaway CODEX_HOME.

async function partA() {
  console.log("\nPart A: MCP servers (made-up mail service and a local program)");
  const home = mkdtempSync(join(tmpdir(), "aihub-probe-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "aihub-probe-run-"));
  const marker = join(cwd, "..", `aihub-probe-marker-${process.pid}.txt`);
  // Keep sign-ins in a file inside the throwaway home, so the probe leaves nothing in Windows' Credential Manager.
  writeFileSync(join(home, "config.toml"), 'mcp_oauth_credentials_store = "file"\n');
  const keyringBefore = credentialManagerEntries();
  const service = await startTestService({ tokenLifetimeSeconds: 15 });
  let server = await AppServer.start(home, LOCKED_DOWN_FEATURES);
  try {
    const mailWork = { mcp_servers: { mail_work: { url: service.url } } };
    const plain = await startThread(server, cwd);
    let work: string;
    try {
      work = await startThread(server, cwd, mailWork);
    } catch (error) {
      finding("Can a thread be given an MCP server in its own config?", `No: thread/start refused it: ${errorText(error)}`);
      return;
    }

    const before = await statuses(server, work, "mail_work").catch((error) => (step(`status: ${errorText(error)}`), []));
    const inPlain = await statuses(server, plain).catch(() => []);
    const global = await statuses(server, null).catch(() => []);
    finding(
      "Can a thread be given an MCP server in its own config, unseen by other threads?",
      `With its config: ${before.map(describeStatus).join("; ") || "not listed"}\n` +
        `Another thread in the same process lists: ${inPlain.map((status) => status.name).join(", ") || "nothing"}\n` +
        `With no thread: ${global.map((status) => status.name).join(", ") || "nothing"}`,
    );

    // Sign in, as the operator would from a card.
    const signedIn = await signIn(server, service, "mail_work", work, "work@example.com").catch((error) => `sign-in error: ${errorText(error)}`);
    const credentialFiles = readdirSync(home).filter((name) => /cred|token|auth/i.test(name));
    finding(
      "Does mcpServer/oauth/login sign a service in?",
      `${signedIn}. Codex registered itself with the service (${service.log.filter((line) => line.startsWith("register")).length} registration) and used PKCE (${service.log.find((line) => line.startsWith("authorize")) ?? "no authorize request"}).\n` +
        `Sign-ins kept in the throwaway home: ${credentialFiles.join(", ") || "no file"}`,
    );

    // A sign-in made after the thread started: does the thread pick it up, or does it need a new thread?
    let afterSignIn = await statuses(server, work, "mail_work").catch(() => []);
    let whoami = await call(server, work, "mail_work", "whoami");
    let freshThread = "";
    if (whoami.startsWith("refused") || whoami.startsWith("error")) {
      work = await startThread(server, cwd, mailWork);
      afterSignIn = await statuses(server, work, "mail_work").catch(() => []);
      freshThread = " (in a new thread: the one that started before the sign-in didn't pick it up)";
      whoami = await call(server, work, "mail_work", "whoami");
    }
    finding(
      "Can the daemon call a service's tools from code, with no model turn?",
      `whoami${freshThread}: ${whoami}\n` +
        `list_messages: ${await call(server, work, "mail_work", "list_messages", { limit: 5 })}\n` +
        `After sign-in: ${afterSignIn.map(describeStatus).join("; ")}`,
    );

    const requestsBefore = server.serverRequests.length;
    const send = await call(server, work, "mail_work", "send_message", { to: "anyone@example.net", subject: "Probe" });
    const tidy = await call(server, work, "mail_work", "tidy_inbox");
    const asked = server.serverRequests.slice(requestsBefore).map((message) => message.method);
    finding(
      "Does Codex hold back a tool that changes things, or one with no labels?",
      `send_message: ${send}. tidy_inbox: ${tidy}.\n` +
        `Codex asked: ${asked.join(", ") || "nothing"}. The service recorded ${service.sent.length} sent message(s).`,
    );

    // Two accounts on one service, as two named services.
    const home2 = await startThread(server, cwd, { mcp_servers: { mail_home: { url: service.url } } });
    const homeSignIn = await signIn(server, service, "mail_home", home2, "home@example.com").catch((error) => `sign-in error: ${errorText(error)}`);
    let homeThread = await startThread(server, cwd, { mcp_servers: { mail_home: { url: service.url } } });
    finding(
      "Can one service hold two accounts as two connections?",
      `mail_home ${homeSignIn}. whoami: mail_work → ${await call(server, work, "mail_work", "whoami")}; mail_home → ${await call(server, homeThread, "mail_home", "whoami")}.\n` +
        `mail_home's thread asking for mail_work: ${await call(server, homeThread, "mail_work", "whoami")}`,
    );

    // Unattended: let the access token expire, then call again.
    const refreshesBefore = service.refreshes();
    step("waiting 20 s for the access tokens to expire…");
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const afterExpiry = await call(server, work, "mail_work", "whoami");
    finding(
      "When an access token expires, does Codex refresh it with no one at the PC?",
      `whoami after expiry: ${afterExpiry}. Refreshes: ${service.refreshes() - refreshesBefore}.`,
    );

    // A restart: does the sign-in survive?
    server.kill();
    server = await AppServer.start(home, LOCKED_DOWN_FEATURES);
    const restarted = await startThread(server, cwd, mailWork);
    homeThread = await startThread(server, cwd, { mcp_servers: { mail_home: { url: service.url } } });
    const restartedStatus = await statuses(server, restarted, "mail_work").catch(() => []);
    finding(
      "Does a sign-in survive a restart of Codex?",
      `${restartedStatus.map((status) => `${status.name}: auth ${status.authStatus}`).join("; ")}. whoami: ${await call(server, restarted, "mail_work", "whoami")}; mail_home: ${await call(server, homeThread, "mail_home", "whoami")}.`,
    );

    // A local program: when does Codex start it?
    const local = { mcp_servers: { local_notes: { command: process.execPath, args: [join(here, "stdio-server.mjs"), marker] } } };
    const startsBefore = existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0;
    const localThread = await startThread(server, cwd, local);
    const localStatus = await statuses(server, localThread, "local_notes").catch((error) => (step(`status: ${errorText(error)}`), []));
    const localCall = await call(server, localThread, "local_notes", "count_notes");
    const starts = existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0;
    const otherThread = await startThread(server, cwd);
    const otherSees = await statuses(server, otherThread).catch(() => []);
    finding(
      "Is a local MCP program started only for the thread that names it?",
      `Starts before its thread: ${startsBefore}; after: ${starts}. ${localStatus.map(describeStatus).join("; ")}. count_notes: ${localCall}.\n` +
        `A thread without it lists: ${otherSees.map((status) => status.name).join(", ") || "nothing"}`,
    );

    const keyringAfter = credentialManagerEntries();
    finding(
      "Did the probe leave anything in Windows' Credential Manager?",
      keyringAfter.length === keyringBefore.length ? "No new entries." : `New entries: ${keyringAfter.filter((line) => !keyringBefore.includes(line)).join("; ")}`,
    );
    console.log(`\n  Service log:\n    ${service.log.join("\n    ")}`);
  } catch (error) {
    console.error(`\nPart A stopped: ${errorText(error)}\n${server.logTail()}`);
    process.exitCode = 1;
  } finally {
    server.kill();
    await service.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Part B: ChatGPT apps on AiHub's own sign-in. Lists only; calls nothing.

async function partB() {
  console.log("\nPart B: ChatGPT apps on AiHub's Codex sign-in (listing only)");
  const home = join(root, ".codex-home");
  if (!existsSync(join(home, "auth.json"))) {
    finding("Which ChatGPT apps does the sign-in offer?", "Skipped: AiHub's Codex isn't signed in (`npm run codex -- login`).");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "aihub-probe-run-"));
  const withApps = LOCKED_DOWN_FEATURES.filter((feature) => feature !== "apps");
  let server = await AppServer.start(home, withApps);
  try {
    const apps: AppsListResponse["data"] = [];
    let cursor: string | null = null;
    do {
      const page = (await server.request("app/list", { cursor, limit: 100 })) as AppsListResponse;
      apps.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const accessible = apps.filter((app) => app.isAccessible);
    finding(
      "Which ChatGPT apps does the sign-in offer?",
      `${apps.length} apps listed, ${accessible.length} connected to this account${accessible.length ? `: ${accessible.map((app) => app.name).join(", ")}` : ""}.\n` +
        `Some of those listed: ${apps.slice(0, 12).map((app) => app.name).join(", ")}`,
    );

    const thread = await startThread(server, cwd);
    const listed = await statuses(server, thread).catch((error) => (step(`status: ${errorText(error)}`), []));
    finding(
      "With apps on, which MCP servers and tools does a thread get?",
      listed.map((status) => {
        const tools = Object.values(status.tools).filter((tool) => tool !== undefined);
        const readOnly = tools.filter((tool) => (tool.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true).length;
        const unlabeled = tools.filter((tool) => !tool.annotations).length;
        return `${status.name}: auth ${status.authStatus}, ${tools.length} tools (${readOnly} labeled read-only, ${unlabeled} unlabeled): ${tools.slice(0, 15).map((tool) => tool.name).join(", ")}${tools.length > 15 ? ", …" : ""}`;
      }).join("\n") || "none",
    );
    // Only on request: one call to a tool the operator chose, such as a search of public repositories.
    const callApp = only.find((arg) => arg.startsWith("--call-app="))?.slice("--call-app=".length);
    if (callApp) {
      const args = JSON.parse(only.find((arg) => arg.startsWith("--args="))?.slice("--args=".length) ?? "{}") as Record<string, unknown>;
      const tool = listed.flatMap((status) => Object.values(status.tools)).find((candidate) => candidate?.name === callApp);
      step(`${callApp}: ${JSON.stringify(tool?.annotations ?? null)}; input ${JSON.stringify(tool?.inputSchema ?? null).slice(0, 300)}`);
      step(`${callApp} _meta: ${JSON.stringify(tool?._meta ?? null).slice(0, 1200)}`);
      step(`codex_apps toolListMeta: ${JSON.stringify(listed.find((status) => status.name === "codex_apps")?.toolListMeta ?? null).slice(0, 1200)}`);
      const accounts = ((tool?._meta as { link_accounts?: Array<{ link_id: string; link_name?: string }> } | undefined)?.link_accounts ?? []);
      step(`${callApp}: ${accounts.length} linked account(s): ${accounts.map((account) => account.link_name ?? "unnamed").join(", ")}`);
      const meta = only.find((arg) => arg.startsWith("--meta="))?.slice("--meta=".length);
      const result = await callWithMeta(server, thread, "codex_apps", callApp, args, meta ? JSON.parse(meta) : undefined);
      finding(`Can the daemon call ${callApp} from code, with no model turn?`, result.length > 400 ? `${result.slice(0, 400)}… (${result.length} characters)` : result);
    }
    server.kill();

    server = await AppServer.start(home, LOCKED_DOWN_FEATURES);
    const lockedThread = await startThread(server, cwd);
    const locked = await statuses(server, lockedThread).catch(() => []);
    finding(
      "With the locked-down features, as AiHub's staff runs have them, is any of that there?",
      locked.map((status) => `${status.name} (${Object.keys(status.tools).length} tools)`).join(", ") || "No MCP servers.",
    );
  } catch (error) {
    console.error(`\nPart B stopped: ${errorText(error)}\n${server.logTail()}`);
    process.exitCode = 1;
  } finally {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(cwd, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2);
if (!only.includes("--apps")) await partA();
if (!only.includes("--mcp")) await partB();
console.log(`\n${findings.length} findings.`);
