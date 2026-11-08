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

  it("turns on cached web search only for a run that holds it, limited to its sites when given", async () => {
    await runtime.startContext({ ...conversation, web: { mode: "cached", sites: [] } });
    await runtime.startContext({ ...conversation, web: { mode: "cached", sites: ["bbc.com"] } });
    const [any, limited] = requests("thread/start");
    assert.deepEqual(any?.params.config, { web_search: "cached" });
    assert.deepEqual(limited?.params.config, { web_search: "cached", tools: { web_search: { allowed_domains: ["bbc.com"] } } });
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

  it("lists the models, leaving out the level that starts Codex's own sub-agents", async () => {
    assert.deepEqual(await runtime.models(), [
      {
        id: "gpt-fake",
        name: "GPT-FAKE",
        description: "The gpt-fake model.",
        efforts: [
          { effort: "low", description: "low reasoning" },
          { effort: "high", description: "high reasoning" },
        ],
        defaultEffort: "low",
        isDefault: true,
      },
      { id: "gpt-fake-mini", name: "GPT-FAKE-MINI", description: "The gpt-fake-mini model.", efforts: [{ effort: "medium", description: "medium reasoning" }], defaultEffort: "medium", isDefault: false },
    ]);
    assert.deepEqual(requests("model/list").map((request) => request.params.cursor ?? null), [null, "page-2"]);
  });

  it("names the model and reasoning level on the turn, and reports what the turn ran on", async () => {
    const contextId = await runtime.startContext(conversation);
    const plain = await runtime.runTurn(contextId, { input: "hello", onToolCall: noTools });
    assert.deepEqual(plain.model, { model: "gpt-fake", effort: null }, "the thread's own model");

    const chosen = await runtime.runTurn(contextId, { input: "hello", onToolCall: noTools, model: { model: "gpt-fake-mini", effort: "medium" } });
    assert.deepEqual(chosen.model, { model: "gpt-fake-mini", effort: "medium" });
    const [first, second] = requests("turn/start");
    assert.equal(first?.params.model, undefined);
    assert.deepEqual([second?.params.model, second?.params.effort], ["gpt-fake-mini", "medium"]);

    // The choice stays with the thread for a turn that names none.
    const after = await runtime.runTurn(contextId, { input: "hello", onToolCall: noTools });
    assert.deepEqual(after.model, { model: "gpt-fake-mini", effort: "medium" });
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

  describe("services", () => {
    const mail = { kind: "remote_mcp", server: "aihub_mail_1a2b3c", url: "https://mail.example.test/mcp" } as const;

    it("reaches services from a connector process of its own, with apps on, and gives a server only to its own thread", async () => {
      await runtime.startContext(conversation);
      const found = await runtime.connectors.inspect(mail);
      assert.deepEqual([found.signedIn, found.tools, found.error], [false, [], null], "it asks for a sign-in");

      const [chat, service] = requests("thread/start");
      assert.notEqual(chat!.pid, service!.pid);
      assert.ok(chat!.argv.join(" ").includes("--disable apps"), "staff processes keep apps off");
      assert.ok(!service!.argv.join(" ").includes("--disable apps"), "the connector process has apps on");
      for (const feature of LOCKED_DOWN_FEATURES.filter((feature) => feature !== "apps")) {
        assert.ok(service!.argv.join(" ").includes(`--disable ${feature}`), `--disable ${feature}`);
      }
      assert.deepEqual(chat!.params.config, { web_search: "disabled" });
      assert.deepEqual(service!.params.config, { web_search: "disabled", mcp_servers: { aihub_mail_1a2b3c: { url: "https://mail.example.test/mcp" } } });
      assert.equal(service!.params.ephemeral, true);
      assert.equal(requests("turn/start").length, 0, "no turn runs in the connector process");

      await runtime.connectors.inspect({ kind: "local_mcp", server: "aihub_files_4d5e6f", command: "node", args: ["server.mjs"] });
      const starts = requests("thread/start");
      assert.equal(starts.length, 3, "each service gets its own thread");
      assert.deepEqual(starts[2]!.params.config, { web_search: "disabled", mcp_servers: { aihub_files_4d5e6f: { command: "node", args: ["server.mjs"] } } });
      await runtime.connectors.inspect(mail);
      assert.equal(requests("thread/start").length, 3, "and keeps it");
    });

    it("signs in, waits for Codex to say it finished, then lists the tools with their labels", async () => {
      const { url, done } = await runtime.connectors.signIn(mail);
      assert.equal(url, "https://auth.example.test/authorize?server=aihub_mail_1a2b3c");
      assert.deepEqual(await done, { ok: true, error: null });
      const [login] = requests("mcpServer/oauth/login");
      assert.equal(login!.params.name, mail.server);
      const found = await runtime.connectors.inspect(mail);
      assert.equal(found.signedIn, true);
      assert.deepEqual(
        found.tools.map((tool) => [tool.name, tool.annotations]),
        [
          ["list_messages", { readOnlyHint: true, destructiveHint: undefined, openWorldHint: false }],
          ["send_message", { readOnlyHint: false, destructiveHint: false, openWorldHint: undefined }],
        ],
      );
      assert.deepEqual(found.tools[0]!.outputSchema, { type: "object", properties: { messages: { type: "array" } } });
      await assert.rejects(() => runtime.connectors.signIn({ kind: "app", appId: "connector_notes" }), /connected at ChatGPT/);
    });

    it("calls a tool from code and reads its structured answer, with an error result not ok", async () => {
      assert.deepEqual(await runtime.connectors.call(mail, "list_messages", {}), { ok: false, text: "401 Unauthorized: not logged in", structured: null });
      await (await runtime.connectors.signIn(mail)).done;
      const read = await runtime.connectors.call(mail, "list_messages", { limit: 5 });
      assert.deepEqual(read, { ok: true, text: '{"messages":[{"id":"m-1","subject":"Hello"}]}', structured: { messages: [{ id: "m-1", subject: "Hello" }] } });
      const [first, second] = requests("mcpServer/tool/call");
      const { threadId, ...rest } = second!.params;
      assert.deepEqual(rest, { server: mail.server, tool: "list_messages", arguments: { limit: 5 } });
      assert.equal(threadId, first!.params.threadId, "every call goes to the service's own thread");
    });

    it("lists the apps across pages, and an app's own tools and linked accounts from the shared apps server", async () => {
      assert.deepEqual(await runtime.connectors.apps(), [
        { id: "connector_notes", name: "Notes", description: "Notes in a made-up app.", connected: true, connectUrl: "https://chatgpt.com/apps/notes" },
        { id: "connector_drive", name: "Drive", description: null, connected: false, connectUrl: "https://chatgpt.com/apps/drive" },
      ]);
      const notes = await runtime.connectors.inspect({ kind: "app", appId: "connector_notes" });
      assert.deepEqual(notes.tools.map((tool) => tool.name), ["notes_list"], "not the other app's tools");
      assert.deepEqual(notes.accounts, [
        { linkId: "link-1", name: "Personal" },
        { linkId: "link-2", name: "Work" },
      ]);
      assert.equal(notes.signedIn, true);
      const called = await runtime.connectors.call({ kind: "app", appId: "connector_notes" }, "notes_list", { link_id: "link-2" });
      assert.deepEqual(called.structured, { notes: [{ id: "n-1", title: "Groceries" }], account: "link-2" });
      assert.equal((await runtime.connectors.call({ kind: "app", appId: "connector_notes" }, "notes_list", {})).ok, false);
    });
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
