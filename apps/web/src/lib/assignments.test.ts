import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, Assignment, Run } from "@aihub/shared";
import { assignmentsOf, assignmentTree, clip, errandOf, hasOpenWork, nameOf, openAssignmentCount, openQuestions, teamWaitOf } from "./assignments.ts";
import { presenceOf } from "./presence.ts";
import { activityLine } from "../format.ts";

function assignment(id: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id,
    kind: "task",
    requesterId: "vera",
    requesterName: "Vera",
    ownerId: "nora",
    ownerName: "Nora",
    parentId: null,
    conversationId: null,
    title: `Task ${id}`,
    brief: "",
    status: "open",
    runBudget: 4,
    runsUsed: 0,
    result: null,
    review: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    title: "",
    description: "",
    workingStyle: "",
    avatar: id,
    hiredAt: "2026-11-07T16:00:00.000Z",
    experience: 0,
    connectionIds: [],
    web: null,
    model: null,
    effort: null,
    role: "supervisor",
    managerId: "vera",
    profile: "conversation",
    state: "idle",
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    agentId: "nora",
    responsibilityId: null,
    assignmentId: null,
    kind: "assignment",
    title: "Work",
    state: "working",
    turns: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    error: null,
    queuedAt: "2026-11-07T16:00:00.000Z",
    startedAt: "2026-11-07T16:00:01.000Z",
    finishedAt: null,
    model: null,
    effort: null,
    ...overrides,
  };
}

describe("assignment tree", () => {
  it("nests each assignment under the one it serves, open work first", () => {
    const list = [
      assignment("w1", { requesterId: "nora", ownerId: "ture", parentId: "t1", status: "accepted", updatedAt: "2026-11-07T16:30:00.000Z" }),
      assignment("t1", { status: "waiting", createdAt: "2026-11-07T16:00:00.000Z" }),
      assignment("w2", { requesterId: "nora", ownerId: "maja", parentId: "t1", createdAt: "2026-11-07T16:10:00.000Z" }),
      assignment("q1", { kind: "question", createdAt: "2026-11-07T16:20:00.000Z" }),
      assignment("old", { status: "delivered", updatedAt: "2026-11-07T15:00:00.000Z" }),
    ];
    const tree = assignmentTree(list);
    const shape = (nodes: ReturnType<typeof assignmentTree>): unknown => nodes.map((node) => [node.assignment.id, shape(node.children)]);
    assert.deepEqual(shape(tree), [
      ["q1", []],
      ["t1", [["w2", []], ["w1", []]]],
      ["old", []],
    ]);
    assert.ok(hasOpenWork(tree[1]!));
    assert.ok(!hasOpenWork(tree[2]!));
  });

  it("keeps a child whose parent is gone, and assignments in a parent loop", () => {
    const tree = assignmentTree([
      assignment("orphan", { parentId: "aged-out" }),
      assignment("a", { parentId: "b", createdAt: "2026-11-07T16:02:00.000Z" }),
      assignment("b", { parentId: "a", createdAt: "2026-11-07T16:01:00.000Z" }),
      assignment("self", { parentId: "self" }),
    ]);
    const ids = (nodes: ReturnType<typeof assignmentTree>): string[] => nodes.flatMap((node) => [node.assignment.id, ...ids(node.children)]);
    assert.deepEqual(ids(tree).sort(), ["a", "b", "orphan", "self"]);
    assert.ok(tree.some((node) => node.assignment.id === "orphan"));
  });
});

describe("assignments of a staff member", () => {
  it("lists what it owns or asked for, open first, and counts open ones", () => {
    const list = [
      assignment("mine-done", { ownerId: "nora", status: "delivered", updatedAt: "2026-11-07T17:00:00.000Z" }),
      assignment("asked", { requesterId: "nora", ownerId: "ture" }),
      assignment("other", { requesterId: "vera", ownerId: "elin" }),
      assignment("mine-waiting", { ownerId: "nora", status: "waiting" }),
    ];
    assert.deepEqual(assignmentsOf("nora", list).map((a) => a.id), ["mine-waiting", "asked", "mine-done"]);
    assert.equal(openAssignmentCount(list), 3);
  });

  it("names staff who have left from their assignments", () => {
    const list = [assignment("w1", { requesterId: "nora", requesterName: "Nora", ownerId: "ture", ownerName: "Ture" })];
    assert.equal(nameOf("nora", [agent("nora", { name: "Nora L" })], list), "Nora L");
    assert.equal(nameOf("ture", [], list), "Ture");
    assert.equal(nameOf("nobody", [], list), null);
    assert.equal(nameOf(null, [], list), null);
  });
});

describe("errands on the floor", () => {
  const question = assignment("q1", { kind: "question", requesterId: "vera", ownerId: "nora" });

  it("shows a colleague answering while its question run is active", () => {
    const runs = { r: run("r", { kind: "question", assignmentId: "q1" }) };
    assert.deepEqual(errandOf("nora", runs, [question]), { kind: "answering", assignment: question });
    assert.equal(errandOf("nora", { r: run("r", { kind: "question", assignmentId: "q1", state: "done" }) }, [question]), null);
  });

  it("shows a supervisor waiting on its team, with how many results are in", () => {
    const list = [
      assignment("t1", { ownerId: "nora", status: "waiting" }),
      assignment("w1", { requesterId: "nora", ownerId: "ture", parentId: "t1", status: "delivered" }),
      assignment("w2", { requesterId: "nora", ownerId: "maja", parentId: "t1" }),
    ];
    const errand = errandOf("nora", {}, list);
    assert.equal(errand?.kind, "waiting_on_team");
    assert.deepEqual(errand?.kind === "waiting_on_team" && { task: errand.wait.task.id, total: errand.wait.total, settled: errand.wait.settled }, { task: "t1", total: 2, settled: 1 });
    assert.equal(teamWaitOf("ture", list), null);
  });

  it("makes a follow-up run look like reviewing", () => {
    const runs = { r: run("r", { kind: "follow_up", assignmentId: "t1" }) };
    const nora = agent("nora", { state: "working" });
    assert.equal(presenceOf(nora, runs, Date.now()), "reviewing");
    assert.equal(errandOf("nora", runs, [])?.kind, "reviewing");
    assert.equal(presenceOf(nora, { r: run("r", { kind: "assignment" }) }, Date.now()), "working");
  });

  it("shows the asker waiting for an answer between runs, and lists open questions only", () => {
    const list = [question, assignment("q2", { kind: "question", status: "delivered" }), assignment("t", { kind: "task" })];
    assert.deepEqual(openQuestions(list).map((a) => a.id), ["q1"]);
    assert.deepEqual(errandOf("vera", {}, list), { kind: "awaiting_answer", assignment: question });
    assert.equal(errandOf("vera", { r: run("r", { agentId: "vera", kind: "chat" }) }, list), null, "a run in progress comes first");
  });

  it("doesn't print a name twice in an activity line", () => {
    assert.deepEqual(activityLine("Nora", "Nora joined as Calendar Supervisor"), { who: null, text: "Nora joined as Calendar Supervisor" });
    assert.deepEqual(activityLine("Vera", "Asked Nora: Room next week?"), { who: "Vera", text: "Asked Nora: Room next week?" });
    assert.deepEqual(activityLine("Nora", "Norah's note"), { who: "Nora", text: "Norah's note" });
  });
});

describe("clip", () => {
  it("keeps short text and cuts long text at a word", () => {
    assert.equal(clip("  Is there   room? "), "Is there room?");
    const clipped = clip("Is there room for a two-hour workshop with the whole team next week?", 30);
    assert.ok(clipped.endsWith("…"));
    assert.ok(clipped.length <= 31);
    assert.equal(clipped, "Is there room for a two-hour…");
  });
});
