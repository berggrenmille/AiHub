import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DaemonEvent } from "@aihub/shared";
import { FakeRuntime } from "./runtime/fake-runtime.ts";
import { Office } from "./office.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT, CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import { Store } from "./store/store.ts";
const NOTE_TOOLS = ["aihub_list_notes", "aihub_read_note", "aihub_write_note"];

function startOffice(store = new Store(":memory:"), runtime = new FakeRuntime()) {
  const office = new Office({ store, runtime });
  office.start();
  const events: DaemonEvent[] = [];
  office.bus.subscribe(({ event }) => events.push(event));
  return { office, store, runtime, events };
}

async function say(office: Office, text: string) {
  const response = office.chat(CHAT, text);
  await office.queue.idle();
  return office.store.getRun(response.run.id)!;
}

describe("Office", () => {
  it("starts with the Chief of Staff and its chat", () => {
    const { office } = startOffice();
    const snapshot = office.snapshot();

    assert.deepEqual(snapshot.agents.map((agent) => [agent.id, agent.state]), [[CHIEF_OF_STAFF_ID, "idle"]]);
    assert.deepEqual(snapshot.conversations.map((conversation) => conversation.id), [CHAT]);
  });

  it("replies in chat, streams the reply, and records the run", async () => {
    const { office, events } = startOffice();

    const run = await say(office, "Good morning");

    assert.equal(run.state, "done");
    assert.equal(run.turns, 1);
    assert.deepEqual(run.usage, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 });
    assert.deepEqual(
      office.store.recentMessages(10, CHAT).map((message) => [message.author, message.body, message.runId]),
      [
        ["operator", "Good morning", run.id],
        ["agent", "Echo: Good morning", run.id],
      ],
    );
    const deltas = events.flatMap((event) => (event.type === "delta" ? [event.text] : []));
    assert.equal(deltas.join(""), "Echo: Good morning");
    const states = events.flatMap((event) => (event.type === "agent" ? [event.agent.state] : []));
    assert.deepEqual(states, ["queued", "working", "working", "idle"]);
  });

  it("sends the agent's tool calls through the gateway", async () => {
    const { office, runtime } = startOffice();
    runtime.respond = async (_input, options) => {
      const roster = await options.onToolCall({ name: "aihub_get_roster", arguments: {} });
      const refused = await options.onToolCall({ name: "aihub_send_mail", arguments: {} });
      return { status: "completed", text: `${roster.text} / ${refused.text}`, error: null, usage: null };
    };

    await say(office, "Who is on staff?");

    const [, reply] = office.store.recentMessages(2, CHAT);
    assert.match(reply!.body, /"name":"Vera","title":"Chief of Staff"/);
    assert.match(reply!.body, /aihub_send_mail is not available to this run/);
    const kinds = office.store.recentActivity(10).map((entry) => entry.kind);
    assert.ok(kinds.includes("tool_call") && kinds.includes("tool_refused"));
  });

  it("gives the Chief of Staff its charter and gateway tools", async () => {
    const { office, runtime } = startOffice();
    await say(office, "Hello");

    const [context] = runtime.contexts.values();
    assert.match(context!.options.instructions, /Chief of Staff in AiHub/);
    assert.deepEqual(context!.options.tools.map((tool) => tool.name), ["aihub_get_roster", "aihub_list_activity", ...NOTE_TOOLS]);
  });

  it("resumes the saved context after a restart", async () => {
    const store = new Store(":memory:");
    const runtime = new FakeRuntime();
    await say(startOffice(store, runtime).office, "First");

    const restarted = startOffice(store, runtime);
    await say(restarted.office, "Second");

    assert.deepEqual(runtime.calls, ["start ctx-1", "turn ctx-1", "resume ctx-1", "turn ctx-1"]);
    assert.deepEqual(runtime.contexts.get("ctx-1")?.inputs, ["First", "Second"]);
  });

  it("rebuilds the chat from saved messages when the context is gone", async () => {
    const store = new Store(":memory:");
    await say(startOffice(store, new FakeRuntime("old")).office, "Remember the number 42");

    const fresh = new FakeRuntime("new");
    const { office } = startOffice(store, fresh);
    await say(office, "What number?");

    assert.deepEqual(fresh.calls, ["resume old-1", "start new-1", "turn new-1"]);
    const [input] = fresh.contexts.get("new-1")!.inputs;
    assert.match(input!, /restored this conversation/);
    assert.match(input!, /Operator: Remember the number 42\n\nVera: Echo: Remember the number 42/);
    assert.match(input!, /The operator's new message:\nWhat number\?$/);
    assert.equal(store.getConversation(CHAT)?.contextId, "new-1");
    assert.equal(store.recentActivity(20).filter((entry) => entry.kind === "context_rebuilt").length, 1);
  });

  it("starts a new context when the charter or tools change", async () => {
    const store = new Store(":memory:");
    const runtime = new FakeRuntime();
    await say(startOffice(store, runtime).office, "First");
    store.setConversationContext(CHAT, "ctx-1", "an older charter");

    await say(startOffice(store, runtime).office, "Second");

    assert.deepEqual(runtime.calls, ["start ctx-1", "turn ctx-1", "start ctx-2", "turn ctx-2"]);
  });

  it("fails the run but keeps the operator's message when the runtime fails", async () => {
    const { office, runtime } = startOffice();
    runtime.respond = async () => {
      throw new Error("Codex App Server exited with code 1");
    };

    const run = await say(office, "Hello?");

    assert.equal(run.state, "failed");
    assert.equal(run.error, "Codex App Server exited with code 1");
    assert.deepEqual(office.store.recentMessages(10, CHAT).map((message) => message.author), ["operator"]);
    assert.equal(office.store.getAgent(CHIEF_OF_STAFF_ID)?.state, "idle");
  });

  it("records a failed turn's partial reply and error", async () => {
    const { office, runtime } = startOffice();
    runtime.respond = async () => ({ status: "interrupted", text: "Half an answer", error: "Turn did not finish within 600s", usage: null });

    const run = await say(office, "Long question");

    assert.equal(run.state, "failed");
    assert.equal(run.error, "Turn did not finish within 600s");
    assert.equal(office.store.recentMessages(1, CHAT)[0]?.body, "Half an answer");
  });

  it("fails runs that a restart interrupted", () => {
    const store = new Store(":memory:");
    startOffice(store);
    const run = store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "chat", title: "Reply in chat" });
    store.setRunState(run.id, "working");

    startOffice(store);

    assert.equal(store.getRun(run.id)?.state, "failed");
    assert.equal(store.getAgent(CHIEF_OF_STAFF_ID)?.state, "idle");
  });

  it("publishes the runtime's sign-in status", async () => {
    const { office, events } = startOffice();

    await office.refreshRuntimeStatus();

    assert.deepEqual(office.snapshot().runtime, { signedIn: true, detail: "operator@example.com, plan plus" });
    assert.equal(events.at(-1)?.type, "runtime");
  });
});
