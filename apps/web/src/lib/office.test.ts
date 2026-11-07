import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, Item, Run } from "@aihub/shared";
import { forceLayout } from "./graph.ts";
import { closedItems, groupOpenItems, openCount } from "./inbox.ts";
import { STATION, layoutOffice } from "./layout.ts";
import { DONE_GLOW_MS, FAILED_MARK_MS, bubbleText, currentRun, openItemCounts, presenceOf } from "./presence.ts";
import { doorOffset, visitOffset, WALKER, walkerAt } from "./walk.ts";

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
    role: "supervisor",
    managerId: "chief",
    profile: "conversation",
    state: "idle",
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    agentId: "chief",
    responsibilityId: null,
    assignmentId: null,
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

function item(id: number, overrides: Partial<Item> = {}): Item {
  return {
    id,
    responsibilityId: "schedule",
    sourceKey: `key-${id}`,
    title: `Item ${id}`,
    detail: "",
    urgency: "fyi",
    state: "open",
    firstSeenAt: "2026-11-07T16:00:00.000Z",
    lastReportedAt: null,
    resolution: null,
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("office layout", () => {
  const chief = agent("chief", { role: "chief_of_staff", managerId: null });

  it("seats everyone once: the chief in her office, supervisors in pods, workers with their manager", () => {
    const agents = [
      chief,
      agent("schedule", { hiredAt: "2026-11-07T16:01:00.000Z" }),
      agent("inbox", { hiredAt: "2026-11-07T16:02:00.000Z" }),
      agent("w1", { role: "worker", managerId: "schedule" }),
      agent("w2", { role: "worker", managerId: "schedule" }),
      agent("w3", { role: "worker", managerId: "schedule" }),
      agent("stray", { role: "worker", managerId: "gone" }),
    ];
    const layout = layoutOffice(agents, 8);
    assert.deepEqual(layout.seats.map((s) => s.agentId).sort(), agents.map((a) => a.id).sort());
    const seat = (id: string) => layout.seats.find((s) => s.agentId === id)!;
    assert.equal(seat("chief").size, "large");
    assert.equal(seat("chief").podId, null);
    assert.equal(seat("schedule").podId, "pod-schedule");
    assert.equal(seat("inbox").podId, "pod-inbox");
    for (const id of ["w1", "w2", "w3"]) assert.equal(seat(id).podId, "pod-schedule");
    assert.equal(seat("stray").podId, null, "a worker without a supervisor gets a hot desk");

    // Up to the supervisor limit, the rest are vacant pods, four to a row past six.
    assert.equal(layout.pods.length, 8);
    assert.equal(layout.pods.filter((p) => p.supervisorId === null).length, 6);
    assert.equal(new Set(layout.pods.map((p) => p.y)).size, 2);
    // Three workers take two rows of two desks, so one desk is spare.
    assert.equal(layout.pods[0]!.spareDesks.length, 1);

    const rects = layout.seats.map((s) => ({ x: s.x, y: s.y, ...STATION[s.size] }));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) assert.ok(!overlaps(rects[a]!, rects[b]!), `${layout.seats[a]!.agentId} overlaps ${layout.seats[b]!.agentId}`);
    }
    for (const r of rects) assert.ok(r.x >= 0 && r.x + r.w <= layout.width && r.y + r.h <= layout.height);
  });

  it("seats a new worker at a spare desk in its supervisor's pod", () => {
    const before = layoutOffice([chief, agent("schedule")], 8);
    const pod = before.pods.find((p) => p.supervisorId === "schedule")!;
    assert.equal(pod.spareDesks.length, 2);
    const after = layoutOffice([chief, agent("schedule"), agent("w1", { role: "worker", managerId: "schedule" })], 8);
    const seat = after.seats.find((s) => s.agentId === "w1")!;
    assert.deepEqual([seat.x, seat.y, seat.size, seat.podId], [pod.spareDesks[0]!.x, pod.spareDesks[0]!.y, "small", pod.id]);
    assert.equal(after.pods.find((p) => p.supervisorId === "schedule")!.spareDesks.length, 1);
  });

  it("makes room for more supervisors than the limit", () => {
    const supervisors = Array.from({ length: 14 }, (_, index) => agent(`s${index}`));
    const layout = layoutOffice([chief, ...supervisors], 8);
    assert.equal(layout.pods.length, 14);
    assert.ok(layout.pods.every((p) => p.supervisorId !== null));
  });
});

describe("walking", () => {
  const chief = agent("chief", { role: "chief_of_staff", managerId: null });
  const layout = layoutOffice([chief, agent("schedule"), agent("w1", { role: "worker", managerId: "schedule" })], 8);
  const seat = (id: string) => layout.seats.find((s) => s.agentId === id)!;

  it("stands up where the seated figure was", () => {
    for (const id of ["chief", "schedule", "w1"]) {
      const s = seat(id);
      const box = walkerAt(s);
      const scale = STATION[s.size].w / 160;
      assert.ok(Math.abs(box.left + WALKER.headX * box.scale - (s.x + 70 * scale)) < 0.01, id);
      assert.ok(Math.abs(box.top + WALKER.headY * box.scale - (s.y + 37 * scale)) < 0.01, id);
    }
  });

  it("walks to the near side of a colleague's desk", () => {
    // The chief's office is on the left, so she stands left of a supervisor's desk, and back.
    const toSupervisor = visitOffset(seat("chief"), seat("schedule"));
    const there = walkerAt(seat("chief")).left + toSupervisor.dx + WALKER.headX * walkerAt(seat("chief")).scale;
    assert.ok(there < seat("schedule").x + 4);
    assert.ok(there > seat("schedule").x - 40);
    const toChief = visitOffset(seat("schedule"), seat("chief"));
    const back = walkerAt(seat("schedule")).left + toChief.dx + WALKER.headX * walkerAt(seat("schedule")).scale;
    assert.ok(back > seat("chief").x + STATION.large.w - 4);
  });

  it("walks out through the door", () => {
    const s = seat("w1");
    const box = walkerAt(s);
    const { dx, dy } = doorOffset(s, layout.door);
    assert.ok(Math.abs(box.left + dx + box.width / 2 - (layout.door.x + 40)) < 0.01);
    assert.ok(box.top + dy + box.height <= layout.door.y);
  });
});

describe("presence", () => {
  const now = Date.parse("2026-11-07T17:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("acts out the agent's state while it is busy", () => {
    assert.equal(presenceOf(agent("chief", { state: "working" }), {}, now), "working");
    assert.equal(presenceOf(agent("chief", { state: "waiting_for_access" }), {}, now), "waiting_for_access");
  });

  it("shows a finished run for a moment and a failed one for longer", () => {
    const idle = agent("chief");
    assert.equal(presenceOf(idle, {}, now), "idle");
    assert.equal(presenceOf(idle, { a: run("a", { state: "done", finishedAt: ago(1000) }) }, now), "done");
    assert.equal(presenceOf(idle, { a: run("a", { state: "done", finishedAt: ago(DONE_GLOW_MS + 1) }) }, now), "idle");
    assert.equal(presenceOf(idle, { a: run("a", { state: "failed", finishedAt: ago(60_000) }) }, now), "failed");
    assert.equal(presenceOf(idle, { a: run("a", { state: "failed", finishedAt: ago(FAILED_MARK_MS + 1) }) }, now), "idle");
  });

  it("finds the newest run still in progress", () => {
    const runs = {
      old: run("old", { state: "done", queuedAt: "2026-11-07T15:00:00.000Z", finishedAt: "2026-11-07T15:01:00.000Z" }),
      busy: run("busy", { state: "working", queuedAt: "2026-11-07T16:00:00.000Z", startedAt: "2026-11-07T16:00:01.000Z" }),
      other: run("other", { agentId: "someone", state: "working" }),
    };
    assert.equal(currentRun("chief", runs)?.id, "busy");
    assert.equal(currentRun("nobody", runs), null);
  });

  it("keeps the end of a long reply for the speech bubble", () => {
    assert.equal(bubbleText("  short   reply "), "short reply");
    const text = bubbleText("one two three four five six seven eight nine ten", 20);
    assert.ok(text.startsWith("…"));
    assert.ok(text.length <= 21);
    assert.ok(text.endsWith("nine ten"));
  });
});

describe("inbox", () => {
  const items = [
    item(1, { urgency: "fyi" }),
    item(2, { urgency: "urgent", responsibilityId: "portfolio", state: "new" }),
    item(3, { urgency: "today", state: "new" }),
    item(4, { urgency: "today", state: "open" }),
    item(5, { state: "resolved", updatedAt: "2026-11-07T17:00:00.000Z" }),
    item(6, { state: "dismissed", updatedAt: "2026-11-07T18:00:00.000Z" }),
  ];

  it("groups open items by responsibility, most pressing first", () => {
    const groups = groupOpenItems(items, []);
    assert.deepEqual(
      groups.map((g) => [g.responsibilityId, g.items.map((i) => i.id)]),
      [
        ["portfolio", [2]],
        ["schedule", [3, 4, 1]],
      ],
    );
    assert.equal(groups[0]!.responsibility, null);
  });

  it("lists closed items newest first and counts the open ones", () => {
    assert.deepEqual(closedItems(items).map((i) => i.id), [6, 5]);
    assert.deepEqual(openCount(items), { open: 4, fresh: 2, urgent: 1 });
    const counts = openItemCounts(items);
    assert.deepEqual(counts.get("schedule"), { count: 3, fresh: 1, top: "today" });
    assert.deepEqual(counts.get("portfolio"), { count: 1, fresh: 1, top: "urgent" });
  });
});

describe("graph layout", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "d", target: "e" },
  ];

  it("is deterministic and stays inside the padding", () => {
    const first = forceLayout(ids, edges, { width: 800, height: 540, padding: 40 });
    const second = forceLayout(ids, edges, { width: 800, height: 540, padding: 40 });
    assert.deepEqual([...first], [...second]);
    assert.equal(first.size, ids.length);
    for (const point of first.values()) {
      assert.ok(point.x >= 40 && point.x <= 760 && point.y >= 40 && point.y <= 500, JSON.stringify(point));
    }
  });

  it("keeps linked notes closer than unlinked ones", () => {
    const layout = forceLayout(ids, edges, { width: 800, height: 540 });
    const distance = (a: string, b: string) => Math.hypot(layout.get(a)!.x - layout.get(b)!.x, layout.get(a)!.y - layout.get(b)!.y);
    assert.ok(distance("a", "b") < distance("a", "f"));
  });

  it("centres a single note and handles none", () => {
    assert.deepEqual(forceLayout(["only"], [], { width: 100, height: 60 }).get("only"), { x: 50, y: 30 });
    assert.equal(forceLayout([], [], { width: 100, height: 60 }).size, 0);
  });
});
