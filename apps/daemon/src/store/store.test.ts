import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MIGRATIONS } from "./migrations.ts";
import { Store } from "./store.ts";

const chief = { id: "chief", name: "Chief of Staff", role: "chief_of_staff", managerId: null, profile: "conversation", charter: "Run the office." } as const;
const schedule = { id: "schedule", name: "Work Schedule", role: "supervisor", managerId: "chief", profile: "data", charter: "Watch the calendar." } as const;

function storeWithStaff() {
  const store = new Store(":memory:");
  store.upsertAgent(chief);
  store.upsertAgent(schedule);
  return store;
}

describe("Store", () => {
  it("migrates a new database and reopens an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-store-"));
    try {
      const path = join(dir, "aihub.db");
      const first = new Store(path);
      first.upsertAgent(chief);
      first.close();

      const second = new Store(path);
      assert.equal(second.listAgents().length, 1);
      second.close();
      assert.ok(MIGRATIONS.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates an existing agent instead of duplicating it", () => {
    const store = storeWithStaff();
    store.upsertAgent({ ...chief, charter: "Run the office well." });

    assert.equal(store.listAgents().length, 2);
    assert.equal(store.getAgentRecord("chief")?.charter, "Run the office well.");
  });

  it("shows each agent in the state of its current run", () => {
    const store = storeWithStaff();
    assert.equal(store.getAgent("chief")?.state, "idle");

    const run = store.createRun({ agentId: "chief", kind: "chat", title: "Reply" });
    assert.equal(store.getAgent("chief")?.state, "queued");
    assert.equal(store.getAgent("schedule")?.state, "idle");

    const working = store.setRunState(run.id, "working");
    assert.equal(store.getAgent("chief")?.state, "working");
    assert.ok(working.startedAt);

    const done = store.setRunState(run.id, "done");
    assert.equal(store.getAgent("chief")?.state, "idle");
    assert.ok(done.finishedAt);
  });

  it("adds up turns and usage per run and per period", () => {
    const store = storeWithStaff();
    const run = store.createRun({ agentId: "chief", kind: "briefing", title: "Morning briefing" });
    store.addTurn(run.id, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 });
    const after = store.addTurn(run.id, { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 });

    assert.equal(after.turns, 2);
    assert.deepEqual(after.usage, { inputTokens: 150, cachedInputTokens: 40, outputTokens: 15 });
    assert.deepEqual(store.usageSince(new Date(0)), { turns: 2, inputTokens: 150, cachedInputTokens: 40, outputTokens: 15 });
    assert.equal(store.usageSince(new Date(Date.now() + 60_000)).turns, 0);
  });

  it("fails runs left unfinished by a restart", () => {
    const store = storeWithStaff();
    const queued = store.createRun({ agentId: "chief", kind: "chat", title: "Reply" });
    const done = store.createRun({ agentId: "schedule", kind: "report", title: "Check calendar" });
    store.setRunState(done.id, "done");

    const failed = store.failUnfinishedRuns("The daemon restarted");

    assert.deepEqual(failed.map((run) => run.id), [queued.id]);
    assert.equal(store.getRun(queued.id)?.error, "The daemon restarted");
    assert.equal(store.getRun(done.id)?.state, "done");
  });

  it("returns the latest messages of each conversation, oldest first", () => {
    const store = storeWithStaff();
    store.ensureConversation({ id: "chief-chat", agentId: "chief", title: "Chief of Staff" });
    store.ensureConversation({ id: "schedule-chat", agentId: "schedule", title: "Work Schedule" });
    for (const body of ["one", "two", "three"]) {
      store.addMessage({ conversationId: "chief-chat", author: "operator", agentId: null, body, runId: null });
    }
    store.addMessage({ conversationId: "schedule-chat", author: "agent", agentId: "schedule", body: "hello", runId: null });

    assert.deepEqual(store.recentMessages(2, "chief-chat").map((m) => m.body), ["two", "three"]);
    assert.deepEqual(store.recentMessages(2).map((m) => m.body), ["two", "three", "hello"]);
  });

  it("keeps a conversation's runtime context with its fingerprint", () => {
    const store = storeWithStaff();
    store.ensureConversation({ id: "chief-chat", agentId: "chief", title: "Chief of Staff" });
    store.setConversationContext("chief-chat", "thread-1", "abc");

    assert.deepEqual(store.getConversation("chief-chat"), {
      id: "chief-chat",
      agentId: "chief",
      title: "Chief of Staff",
      contextId: "thread-1",
      contextFingerprint: "abc",
      sourceData: false,
      seenMessageId: 0,
    });
    assert.deepEqual(store.listConversations(), [{ id: "chief-chat", agentId: "chief", title: "Chief of Staff" }]);
  });

  it("stores settings", () => {
    const store = new Store(":memory:");
    assert.equal(store.getSetting("token"), null);
    store.setSetting("token", "a");
    store.setSetting("token", "b");
    assert.equal(store.getSetting("token"), "b");
  });
});
