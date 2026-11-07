import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEntry, Agent, ChatMessage, DaemonEvent, Run, StateSnapshot } from "@aihub/shared";
import { ACTIVITY_LIMIT, initialOfficeState, officeReducer, rosterOrder, type OfficeAction, type OfficeState } from "./state.ts";

const CHAT = "chief-of-staff";

function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: "chief-of-staff", name: "Chief of Staff", role: "chief_of_staff", managerId: null, profile: "conversation", state: "idle", ...overrides };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    agentId: "chief-of-staff",
    kind: "chat",
    title: "Reply in chat",
    state: "queued",
    turns: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    error: null,
    queuedAt: "2026-11-07T16:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    conversationId: CHAT,
    author: "operator",
    agentId: null,
    body: "Hello",
    runId: "run-1",
    createdAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

function reply(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({ id: 2, author: "agent", agentId: "chief-of-staff", body: "Hi there", ...overrides });
}

function activity(id: number, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return { id, at: "2026-11-07T16:00:00.000Z", agentId: "chief-of-staff", runId: "run-1", kind: "run_queued", summary: `Entry ${id}`, ...overrides };
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    agents: [agent()],
    conversations: [{ id: CHAT, agentId: "chief-of-staff", title: "Chief of Staff" }],
    messages: [],
    runs: [],
    activity: [],
    runtime: { signedIn: true, detail: "operator@example.com" },
    lastEventId: "boot-0",
    ...overrides,
  };
}

function apply(state: OfficeState, ...actions: OfficeAction[]): OfficeState {
  return actions.reduce(officeReducer, state);
}

function events(state: OfficeState, ...list: DaemonEvent[]): OfficeState {
  return apply(state, ...list.map((event): OfficeAction => ({ type: "event", event })));
}

const loaded = () => apply(initialOfficeState, { type: "snapshot", snapshot: snapshot() });

describe("office state", () => {
  it("loads a snapshot, grouping messages by conversation in order", () => {
    const state = apply(initialOfficeState, {
      type: "snapshot",
      snapshot: snapshot({
        messages: [reply({ id: 4 }), message({ id: 3 }), message({ id: 5, conversationId: "other" })],
        runs: [run()],
        activity: [activity(1), activity(3), activity(2)],
      }),
    });

    assert.equal(state.loaded, true);
    assert.deepEqual(state.messages[CHAT]?.map((m) => m.id), [3, 4]);
    assert.deepEqual(state.messages.other?.map((m) => m.id), [5]);
    assert.equal(state.runs["run-1"]?.state, "queued");
    assert.deepEqual(state.activity.map((entry) => entry.id), [3, 2, 1]);
    assert.equal(state.runtime?.signedIn, true);
  });

  it("keeps one copy of a message that arrives on the stream and in the POST response", () => {
    const operator = message({ id: 7 });
    let state = events(loaded(), { type: "message", message: operator }, { type: "run", run: run({ state: "working" }) });
    state = apply(state, { type: "sent", response: { message: operator, run: run() } });
    state = events(state, { type: "message", message: operator });

    assert.deepEqual(state.messages[CHAT]?.map((m) => m.id), [7]);
  });

  it("keeps messages in ID order when they arrive out of order", () => {
    const state = events(loaded(), { type: "message", message: message({ id: 9 }) }, { type: "message", message: message({ id: 8 }) });
    assert.deepEqual(state.messages[CHAT]?.map((m) => m.id), [8, 9]);
  });

  it("doesn't let the POST response roll back a run the stream has moved on", () => {
    const sent = { message: message(), run: run({ state: "queued" }) };

    const afterStream = apply(events(loaded(), { type: "run", run: run({ state: "working" }) }), { type: "sent", response: sent });
    assert.equal(afterStream.runs["run-1"]?.state, "working");

    const beforeStream = apply(loaded(), { type: "sent", response: sent });
    assert.equal(beforeStream.runs["run-1"]?.state, "queued");
    assert.equal(events(beforeStream, { type: "run", run: run({ state: "working" }) }).runs["run-1"]?.state, "working");
  });

  it("buffers deltas per run until the reply arrives", () => {
    let state = events(
      loaded(),
      { type: "run", run: run({ state: "working" }) },
      { type: "delta", runId: "run-1", conversationId: CHAT, text: "Hel" },
      { type: "delta", runId: "run-1", conversationId: CHAT, text: "lo" },
      { type: "delta", runId: "run-2", conversationId: "other", text: "Hey" },
    );
    assert.deepEqual(state.streaming["run-1"], { runId: "run-1", conversationId: CHAT, text: "Hello" });
    assert.equal(state.streaming["run-2"]?.text, "Hey");

    // The operator's message with the same run doesn't end the reply; the agent's does.
    state = events(state, { type: "message", message: message({ id: 1 }) });
    assert.equal(state.streaming["run-1"]?.text, "Hello");
    state = events(state, { type: "message", message: reply({ id: 2, body: "Hello" }) });
    assert.equal(state.streaming["run-1"], undefined);
    assert.equal(state.streaming["run-2"]?.text, "Hey");
  });

  it("clears streamed text when the run is done or fails without a reply", () => {
    const streaming = events(
      loaded(),
      { type: "run", run: run({ state: "working" }) },
      { type: "delta", runId: "run-1", conversationId: CHAT, text: "Partial" },
    );

    assert.equal(events(streaming, { type: "run", run: run({ state: "working", turns: 1 }) }).streaming["run-1"]?.text, "Partial");
    assert.equal(events(streaming, { type: "run", run: run({ state: "done" }) }).streaming["run-1"], undefined);
    const failed = events(streaming, { type: "run", run: run({ state: "failed", error: "Timed out" }) });
    assert.equal(failed.streaming["run-1"], undefined);
    assert.equal(failed.runs["run-1"]?.error, "Timed out");
  });

  it("ignores deltas for a run that has already finished", () => {
    const state = events(loaded(), { type: "run", run: run({ state: "done" }) });
    assert.equal(events(state, { type: "delta", runId: "run-1", conversationId: CHAT, text: "late" }), state);
  });

  it("upserts runs by ID", () => {
    const state = events(
      loaded(),
      { type: "run", run: run({ id: "run-1", state: "queued" }) },
      { type: "run", run: run({ id: "run-2", state: "queued" }) },
      { type: "run", run: run({ id: "run-1", state: "working", startedAt: "2026-11-07T16:00:01.000Z" }) },
    );
    assert.deepEqual(Object.keys(state.runs).sort(), ["run-1", "run-2"]);
    assert.equal(state.runs["run-1"]?.state, "working");
    assert.equal(state.runs["run-2"]?.state, "queued");
  });

  it("upserts agents by ID and keeps their order", () => {
    const supervisor = agent({ id: "inbox", name: "Work Inbox", role: "supervisor", managerId: "chief-of-staff" });
    const state = events(
      loaded(),
      { type: "agent", agent: supervisor },
      { type: "agent", agent: agent({ state: "working" }) },
    );
    assert.deepEqual(state.agents.map((a) => [a.id, a.state]), [
      ["chief-of-staff", "working"],
      ["inbox", "idle"],
    ]);
  });

  it("prepends activity once each, newest first, up to the limit", () => {
    let state = events(loaded(), { type: "activity", entry: activity(1) }, { type: "activity", entry: activity(2) });
    const before = state;
    state = events(state, { type: "activity", entry: activity(2) });
    assert.equal(state, before);
    assert.deepEqual(state.activity.map((entry) => entry.id), [2, 1]);

    for (let id = 3; id <= ACTIVITY_LIMIT + 5; id++) state = events(state, { type: "activity", entry: activity(id) });
    assert.equal(state.activity.length, ACTIVITY_LIMIT);
    assert.equal(state.activity[0]?.id, ACTIVITY_LIMIT + 5);
  });

  it("updates the runtime sign-in status", () => {
    const state = events(loaded(), { type: "runtime", runtime: { signedIn: false, detail: "Not signed in" } });
    assert.deepEqual(state.runtime, { signedIn: false, detail: "Not signed in" });
  });

  it("waits for the new snapshot on resync, which then replaces the state", () => {
    let state = events(
      loaded(),
      { type: "message", message: message({ id: 1, runId: "run-1" }) },
      { type: "message", message: message({ id: 3, runId: "run-2" }) },
      { type: "run", run: run({ id: "run-1", state: "working" }) },
      { type: "run", run: run({ id: "run-2", state: "working" }) },
      { type: "delta", runId: "run-1", conversationId: CHAT, text: "Still going" },
      { type: "delta", runId: "run-2", conversationId: CHAT, text: "Cut off" },
      { type: "activity", entry: activity(5) },
    );
    assert.equal(events(state, { type: "resync" }), state);

    state = apply(state, {
      type: "snapshot",
      snapshot: snapshot({
        messages: [message({ id: 1, runId: "run-1" }), message({ id: 3, runId: "run-2" })],
        runs: [run({ id: "run-2", state: "failed", error: "The daemon stopped before this run finished." }), run({ id: "run-1", state: "working" })],
        activity: [activity(6, { kind: "run_failed" })],
        runtime: { signedIn: false, detail: "Signed out" },
        lastEventId: "boot2-0",
      }),
    });

    assert.deepEqual(Object.keys(state.streaming), ["run-1"]);
    assert.equal(state.streaming["run-1"]?.text, "Still going");
    assert.equal(state.runs["run-2"]?.state, "failed");
    assert.deepEqual(state.activity.map((entry) => entry.id), [6]);
    assert.equal(state.runtime?.signedIn, false);

    // A reply the snapshot already holds is no longer streaming either.
    const answered = apply(state, {
      type: "snapshot",
      snapshot: snapshot({ messages: [message({ id: 1 }), reply({ id: 2, runId: "run-1" })], runs: [run({ id: "run-1", state: "working" })] }),
    });
    assert.deepEqual(answered.streaming, {});
  });

  it("tracks the connection and its last error", () => {
    let state = apply(initialOfficeState, { type: "connection", status: "connecting", error: "HTTP 502" });
    assert.equal(state.error, "HTTP 502");
    state = apply(state, { type: "connection", status: "connected", error: null });
    assert.equal(state.connection, "connected");
    assert.equal(state.error, null);
    assert.equal(apply(state, { type: "connection", status: "connected", error: null }), state);
  });
});

describe("roster order", () => {
  it("lists each manager before its reports, with their depth", () => {
    const agents = [
      agent({ id: "worker", name: "Worker", role: "worker", managerId: "calendar" }),
      agent({ id: "calendar", name: "Work Schedule", role: "supervisor", managerId: "chief-of-staff" }),
      agent({ id: "inbox", name: "Work Inbox", role: "supervisor", managerId: "chief-of-staff" }),
      agent(),
    ];
    assert.deepEqual(
      rosterOrder(agents).map(({ agent, depth }) => [agent.id, depth]),
      [
        ["chief-of-staff", 0],
        ["calendar", 1],
        ["worker", 2],
        ["inbox", 1],
      ],
    );
  });

  it("still lists agents whose managers are missing or form a loop", () => {
    const agents = [
      agent(),
      agent({ id: "orphan", role: "supervisor", managerId: "gone" }),
      agent({ id: "a", role: "worker", managerId: "b" }),
      agent({ id: "b", role: "worker", managerId: "a" }),
    ];
    assert.deepEqual(rosterOrder(agents).map(({ agent }) => agent.id), ["chief-of-staff", "orphan", "a", "b"]);
  });
});
