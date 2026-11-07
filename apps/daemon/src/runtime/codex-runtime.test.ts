import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOCKED_DOWN_FEATURES } from "./app-server.ts";
import type { RateLimitSnapshot } from "@aihub/codex-protocol/v2";
import { CodexRuntime, pinnedCodexCommand, usageFrom } from "./codex-runtime.ts";
import { ContextUnavailableError, type ContextOptions, type ToolCall, type TurnEvent } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const fakeServer = join(here, "..", "..", "test", "fake-app-server.mjs");

const conversation: ContextOptions = {
  profile: "conversation",
  instructions: "You are the Chief of Staff.",
  tools: [{ name: "aihub_get_roster", description: "List the staff.", inputSchema: { type: "object", properties: {} } }],
};

interface LoggedRequest {
  pid: number;
  argv: string[];
  method: string;
  params: Record<string, unknown>;
}

describe("CodexRuntime", () => {
  let dir: string;
  let logPath: string;
  let runtime: CodexRuntime;

  const requests = (method: string): LoggedRequest[] =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as LoggedRequest)
          .filter((request) => request.method === method)
      : [];

  const noTools = async (call: ToolCall) => ({ ok: false, text: `unexpected tool ${call.name}` });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aihub-test-"));
    logPath = join(dir, "requests.jsonl");
    // The real command with the fake in place of codex.js, so the test sees the flags AiHub really passes.
    const real = pinnedCodexCommand(root);
    runtime = new CodexRuntime({
      command: { command: real.command, args: [fakeServer, ...real.args.slice(1)] },
      codexHome: dir,
      env: { FAKE_CODEX_LOG: logPath },
    });
  });

  afterEach(async () => {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts every app server with the locked-down features and a read-only thread", async () => {
    await runtime.startContext(conversation);

    const [start] = requests("thread/start");
    assert.ok(start);
    for (const feature of LOCKED_DOWN_FEATURES) {
      const flag = start.argv.indexOf(feature);
      assert.ok(flag > 0 && start.argv[flag - 1] === "--disable", `--disable ${feature}`);
    }
    assert.equal(start.params.sandbox, "read-only");
    assert.equal(start.params.approvalPolicy, "untrusted");
    assert.deepEqual(start.params.config, { web_search: "disabled" });
    assert.equal(start.params.developerInstructions, conversation.instructions);
    assert.deepEqual(start.params.dynamicTools, [{ type: "function", ...conversation.tools[0] }]);
    // An empty directory outside the repository, so Codex loads no project instructions or config.
    assert.ok(relative(root, String(start.params.cwd)).startsWith(".."));
  });

  it("streams a reply and reports the turn's token usage", async () => {
    const contextId = await runtime.startContext(conversation);
    const deltas: string[] = [];

    const result = await runtime.runTurn(contextId, {
      input: "good morning",
      onToolCall: noTools,
      onEvent: (event) => event.type === "delta" && deltas.push(event.text),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "Echo: good morning");
    assert.ok(deltas.length > 1);
    assert.equal(deltas.join(""), result.text);
    assert.deepEqual(result.usage, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 });
  });

  it("routes tool calls through the handler and returns the final answer", async () => {
    const contextId = await runtime.startContext(conversation);
    const calls: ToolCall[] = [];

    const result = await runtime.runTurn(contextId, {
      input: 'tool aihub_get_roster {"team":"all"}',
      onToolCall: async (call) => {
        calls.push(call);
        return { ok: true, text: "Chief of Staff" };
      },
    });

    assert.deepEqual(calls, [{ name: "aihub_get_roster", arguments: { team: "all" } }]);
    assert.equal(result.text, "Tool replied (ok): Chief of Staff");
    // Two model requests: one before the tool call and one after.
    assert.deepEqual(result.usage, { inputTokens: 200, cachedInputTokens: 80, outputTokens: 20 });
  });

  it("reports a tool handler that throws as a failed tool call", async () => {
    const contextId = await runtime.startContext(conversation);

    const result = await runtime.runTurn(contextId, {
      input: "tool aihub_get_roster",
      onToolCall: async () => {
        throw new Error("database is locked");
      },
    });

    assert.equal(result.text, "Tool replied (failed): Tool aihub_get_roster failed: database is locked");
  });

  it("declines command approvals and reports them as blocked", async () => {
    const contextId = await runtime.startContext(conversation);
    const events: TurnEvent[] = [];

    const result = await runtime.runTurn(contextId, { input: "shell", onToolCall: noTools, onEvent: (e) => events.push(e) });

    assert.equal(result.text, "Approval: decline");
    assert.deepEqual(
      events.filter((event) => event.type === "blocked"),
      [{ type: "blocked", what: "run a command: type C:\\secret.txt" }],
    );
  });

  it("interrupts a turn that runs past its timeout", async () => {
    const contextId = await runtime.startContext(conversation);

    const result = await runtime.runTurn(contextId, { input: "hang", onToolCall: noTools, timeoutMs: 200 });

    assert.equal(result.status, "interrupted");
    assert.match(result.error ?? "", /did not finish/);
    assert.equal(requests("turn/interrupt").length, 1);
  });

  it("reports a failed turn", async () => {
    const contextId = await runtime.startContext(conversation);

    const result = await runtime.runTurn(contextId, { input: "fail", onToolCall: noTools });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "The model refused");
    assert.equal(result.blocker, null, "no reason waiting would fix");
  });

  it("says when a failed turn may succeed after waiting", async () => {
    const contextId = await runtime.startContext(conversation);
    const blockers: Record<string, string | null> = {
      usageLimitExceeded: "usage",
      unauthorized: "signed_out",
      "401": "signed_out",
      offline: "offline",
      serverOverloaded: "busy",
      "429": "busy",
      "503": "busy",
      contextWindowExceeded: null,
      "400": null,
    };
    for (const [info, blocker] of Object.entries(blockers)) {
      const result = await runtime.runTurn(contextId, { input: `fail ${info}`, onToolCall: noTools });
      assert.deepEqual([info, result.status, result.blocker], [info, "failed", blocker]);
    }
  });

  it("resumes a saved context in a new process after the app server crashes", async () => {
    const contextId = await runtime.startContext(conversation);
    await runtime.runTurn(contextId, { input: "hello", onToolCall: noTools });

    const crashed = await runtime.runTurn(contextId, { input: "crash", onToolCall: noTools });
    assert.equal(crashed.status, "failed");
    assert.match(crashed.error ?? "", /exited/);

    const result = await runtime.runTurn(contextId, { input: "are you back?", onToolCall: noTools });
    assert.equal(result.text, "Echo: are you back?");
    // Measured against the thread's saved total, not counted from zero.
    assert.deepEqual(result.usage, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 });
    const [start] = requests("thread/start");
    const [resume] = requests("thread/resume");
    assert.equal(resume?.params.threadId, contextId);
    assert.notEqual(resume?.pid, start?.pid);
  });

  it("throws ContextUnavailableError when a thread cannot be resumed", async () => {
    await assert.rejects(runtime.resumeContext("no-such-thread", conversation), ContextUnavailableError);

    const ephemeral = await runtime.startContext({ ...conversation, ephemeral: true });
    await runtime.runTurn(ephemeral, { input: "crash", onToolCall: noTools });
    await assert.rejects(runtime.runTurn(ephemeral, { input: "hello", onToolCall: noTools }), ContextUnavailableError);
  });

  it("runs data contexts in their own process", async () => {
    await runtime.startContext(conversation);
    await runtime.startContext({ ...conversation, profile: "data", ephemeral: true });

    const [conversationStart, dataStart] = requests("thread/start");
    assert.ok(conversationStart && dataStart);
    assert.notEqual(conversationStart.pid, dataStart.pid);
  });

  it("refuses workspace contexts until Roadmap phase B", async () => {
    await assert.rejects(runtime.startContext({ ...conversation, profile: "workspace" }), /phase B/);
  });

  it("reads the account and usage limits", async () => {
    assert.deepEqual(await runtime.account(), { signedIn: true, detail: "operator@example.com, plan plus" });
    assert.deepEqual(await runtime.usageLimits(), { usedPercent: 12, resetsAt: new Date(1_900_000_000_000), exhausted: false });
  });
});

describe("usageFrom", () => {
  const window = (usedPercent: number, resetsAt: number) => ({ usedPercent, windowDurationMins: null, resetsAt });
  const snapshot = (overrides: Partial<RateLimitSnapshot>): RateLimitSnapshot => ({
    limitId: null,
    limitName: null,
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
    ...overrides,
  });

  it("reports the fuller window, since it decides when turns can run again", () => {
    assert.deepEqual(usageFrom(snapshot({ primary: window(40, 1_000), secondary: window(100, 9_000) })), {
      usedPercent: 100,
      resetsAt: new Date(9_000_000),
      exhausted: true,
    });
    assert.equal(usageFrom(snapshot({ primary: window(100, 1_000), credits: { hasCredits: true, unlimited: false, balance: "5" } }))?.exhausted, false, "credits go on");
    assert.equal(usageFrom(snapshot({ primary: window(70, 1_000), rateLimitReachedType: "rate_limit_reached" }))?.exhausted, true);
    assert.equal(usageFrom(snapshot({})), null);
  });
});
