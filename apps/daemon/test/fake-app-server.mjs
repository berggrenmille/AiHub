// A stand-in for `codex app-server` that speaks the same JSON-RPC over stdio, for offline contract
// tests of the Codex runtime. The turn's input text picks the scenario:
//   tool <name> <json>  calls an AiHub tool, then reports what it returned
//   shell               asks for approval to run a command, then reports the decision
//   hang                never finishes until interrupted
//   fail                finishes with an error
//   crash               exits the process mid-turn
//   anything else       echoes the input back
// Every client request is appended to FAKE_CODEX_LOG as JSON, with this process's ID and arguments.
// Non-ephemeral threads are saved in CODEX_HOME, so a restarted fake can resume them.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const savedThreadsPath = join(process.env.CODEX_HOME ?? ".", "fake-threads.json");
const savedThreads = existsSync(savedThreadsPath) ? JSON.parse(readFileSync(savedThreadsPath, "utf8")) : {};
const threads = new Map(); // threadId → { total }
const hangingTurns = new Map(); // turnId → threadId
const pendingReplies = new Map();
let nextServerRequest = 1;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });

function serverRequest(method, params) {
  const id = `srv-${nextServerRequest++}`;
  send({ id, method, params });
  return new Promise((resolve) => pendingReplies.set(id, resolve));
}

function log(method, params) {
  if (!process.env.FAKE_CODEX_LOG) return;
  appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), method, params })}\n`);
}

function save(threadId) {
  savedThreads[threadId] = threads.get(threadId).total;
  writeFileSync(savedThreadsPath, JSON.stringify(savedThreads));
}

const usage = (input, cached, output) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: 0,
});

/** One model request: 100 input tokens (40 cached) and 10 output tokens. */
function modelRequest(threadId, turnId) {
  const thread = threads.get(threadId);
  const last = usage(100, 40, 10);
  const t = thread.total;
  thread.total = usage(t.inputTokens + 100, t.cachedInputTokens + 40, t.outputTokens + 10);
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: thread.total, last, modelContextWindow: null } });
}

function agentMessage(threadId, turnId, text, phase) {
  const item = { type: "agentMessage", id: randomUUID(), text, phase, memoryCitation: null, delivery: null, questions: null };
  notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
}

function completeTurn(threadId, turnId, status, error = null) {
  const turn = { id: turnId, rootTurnId: null, items: [], itemsView: "notLoaded", status, error, startedAt: null, completedAt: null, durationMs: null };
  notify("turn/completed", { threadId, turn });
}

function reply(threadId, turnId, text) {
  const pieces = text.match(/.{1,6}/gs) ?? [""];
  for (const delta of pieces) notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg", delta });
  agentMessage(threadId, turnId, text, "final_answer");
  modelRequest(threadId, turnId);
  completeTurn(threadId, turnId, "completed");
}

/** A codexErrorInfo: "offline" has no HTTP status, a number is an HTTP status, anything else is the info itself. */
function errorInfo(name) {
  if (!name) return null;
  if (name === "offline") return { httpConnectionFailed: { httpStatusCode: null } };
  if (/^\d+$/.test(name)) return { responseStreamConnectionFailed: { httpStatusCode: Number(name) } };
  return name;
}

async function runTurn(threadId, turnId, input) {
  const [command, name, ...rest] = input.split(" ");
  switch (command) {
    case "tool": {
      agentMessage(threadId, turnId, `Calling ${name}.`, "commentary");
      modelRequest(threadId, turnId);
      const result = await serverRequest("item/tool/call", {
        threadId,
        turnId,
        callId: randomUUID(),
        namespace: null,
        tool: name,
        arguments: JSON.parse(rest.join(" ") || "{}"),
      });
      const text = result.result.contentItems.map((item) => item.text).join("");
      return reply(threadId, turnId, `Tool replied (${result.result.success ? "ok" : "failed"}): ${text}`);
    }
    case "shell": {
      const result = await serverRequest("item/commandExecution/requestApproval", {
        threadId,
        turnId,
        itemId: randomUUID(),
        command: "type C:\\secret.txt",
      });
      return reply(threadId, turnId, `Approval: ${result.result?.decision ?? result.error?.message}`);
    }
    case "hang":
      hangingTurns.set(turnId, threadId);
      return;
    case "fail":
      // "fail" alone fails for no stated reason; "fail <info>" fails as Codex does for that cause.
      modelRequest(threadId, turnId);
      return completeTurn(threadId, turnId, "failed", { message: name ? `Failed: ${name}` : "The model refused", codexErrorInfo: errorInfo(name), additionalDetails: null, misalignment: null });
    case "crash":
      process.exit(3);
    default:
      return reply(threadId, turnId, `Echo: ${input}`);
  }
}

function handle(message) {
  const { id, method, params } = message;
  log(method, params);
  switch (method) {
    case "initialize":
      return send({ id, result: { userAgent: "fake-codex/0.0.0", codexHome: process.env.CODEX_HOME, platformFamily: "windows", platformOs: "windows" } });
    case "initialized":
      return;
    case "account/read":
      return send({
        id,
        result: {
          account: { type: "chatgpt", email: "operator@example.com", planType: "plus", workspaceName: null },
          requiresOpenaiAuth: true,
          workspaceRouting: null,
        },
      });
    case "account/rateLimits/read":
      return send({ id, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null } } });
    case "thread/start": {
      const threadId = randomUUID();
      threads.set(threadId, { total: usage(0, 0, 0) });
      if (!params.ephemeral) save(threadId);
      return send({ id, result: { thread: { id: threadId }, model: params.model ?? "gpt-fake", reasoningEffort: null } });
    }
    case "thread/resume": {
      const total = savedThreads[params.threadId];
      if (!total) return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
      threads.set(params.threadId, { total });
      return send({ id, result: { thread: { id: params.threadId } } });
    }
    case "turn/start": {
      const { threadId } = params;
      const turnId = randomUUID();
      if (!threads.has(threadId)) return send({ id, error: { code: -32600, message: `thread not found: ${threadId}` } });
      // The echo scenario runs synchronously, so its whole turn, completion included, arrives
      // before the turn/start response. That proves the client copes with notifications that race it.
      const started = runTurn(threadId, turnId, params.input.map((part) => part.text).join(""));
      send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      return started.then(() => {
        if (savedThreads[threadId]) save(threadId);
      });
    }
    case "model/list": {
      // Two pages, so the client has to follow the cursor.
      const effort = (reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` });
      const model = (name, isDefault, efforts) => ({
        id: name,
        model: name,
        displayName: name.toUpperCase(),
        description: `The ${name} model.`,
        hidden: false,
        supportedReasoningEfforts: efforts.map(effort),
        defaultReasoningEffort: efforts[0],
        isDefault,
      });
      if (!params.cursor) return send({ id, result: { data: [model("gpt-fake", true, ["low", "high", "ultra"])], nextCursor: "page-2" } });
      return send({ id, result: { data: [model("gpt-fake-mini", false, ["medium"])], nextCursor: null } });
    }
    case "turn/interrupt": {
      send({ id, result: {} });
      const threadId = hangingTurns.get(params.turnId);
      hangingTurns.delete(params.turnId);
      if (threadId) completeTurn(threadId, params.turnId, "interrupted");
      return;
    }
    default:
      if (id !== undefined && method === undefined) {
        pendingReplies.get(id)?.(message);
        pendingReplies.delete(id);
        return;
      }
      if (id !== undefined) send({ id, error: { code: -32601, message: `fake app server has no ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) handle(JSON.parse(line));
});
