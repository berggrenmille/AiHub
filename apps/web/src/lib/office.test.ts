import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, Item, Run } from "@aihub/shared";
import { forceLayout } from "./graph.ts";
import { closedItems, openCount } from "./inbox.ts";
import { itemsWaiting } from "./today.ts";
import { STATION, layoutOffice, meetingSeats, meetingTable } from "./layout.ts";
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
    web: null,
    model: null,
    effort: null,
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
    model: null,
    effort: null,
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
    link: null,
    needsOperator: true,
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

  it("gives a worker who reports to the Chief of Staff, such as a toolsmith, a hot desk in the lounge", () => {
    const staff = [chief, agent("schedule"), agent("reading", { hiredAt: "2026-11-07T16:01:00.000Z" })];
    const ada = agent("ada", { role: "worker", managerId: "chief", hiredAt: "2026-11-07T17:00:00.000Z" });
    const layout = layoutOffice([...staff, ada], 8);
    const seat = layout.seats.find((s) => s.agentId === "ada")!;
    assert.deepEqual([seat.size, seat.podId], ["small", null]);

    const desk = { x: seat.x, y: seat.y, ...STATION.small };
    const { lounge } = layout;
    assert.ok(desk.x >= lounge.x && desk.x + desk.w <= lounge.x + lounge.w, "inside the lounge, left to right");
    assert.ok(desk.y >= lounge.y && desk.y + desk.h <= lounge.y + lounge.h, "inside the lounge, top to bottom");
    assert.ok(!overlaps(desk, layout.chiefRoom));
    for (const pod of layout.pods) assert.ok(!overlaps(desk, pod), pod.id);

    // Nobody else moves as the toolsmith comes and goes, so the walk in and out lines up.
    const before = layoutOffice(staff, 8);
    for (const other of before.seats) assert.deepEqual(layout.seats.find((s) => s.agentId === other.agentId), other);
    assert.deepEqual(layout.lounge.y, before.lounge.y);

    // And the way out leads through the door.
    const box = walkerAt(seat);
    const { dx, dy } = doorOffset(seat, layout.door);
    assert.ok(Math.abs(box.left + dx + box.width / 2 - (layout.door.x + 40)) < 0.01);
    assert.ok(box.top + dy + box.height <= layout.door.y);
  });

  it("makes room for more supervisors than the limit", () => {
    const supervisors = Array.from({ length: 14 }, (_, index) => agent(`s${index}`));
    const layout = layoutOffice([chief, ...supervisors], 8);
    assert.equal(layout.pods.length, 14);
    assert.ok(layout.pods.every((p) => p.supervisorId !== null));
  });

  it("adds pods a row at a time, up to four by four", () => {
    const pods = (count: number) => layoutOffice([chief, ...Array.from({ length: count }, (_, index) => agent(`s${index}`))], 16).pods.length;
    assert.deepEqual([pods(0), pods(5), pods(7), pods(8), pods(11), pods(12), pods(16)], [8, 8, 8, 12, 12, 16, 16]);
  });

  it("fits sixteen supervisors on four rows, a row only as tall as its workers need, with the meeting room under them", () => {
    const supervisors = Array.from({ length: 16 }, (_, index) => agent(`s${index}`, { hiredAt: `2026-11-07T16:${String(index).padStart(2, "0")}:00.000Z` }));
    const helper = agent("w1", { role: "worker", managerId: "s5" });
    const layout = layoutOffice([chief, ...supervisors, helper], 16);
    assert.equal(layout.pods.length, 16);
    assert.ok(layout.pods.every((p) => p.supervisorId !== null));
    assert.equal(new Set(layout.pods.map((p) => p.x)).size, 4);
    assert.equal(new Set(layout.pods.map((p) => p.y)).size, 4);
    const heights = [...new Set(layout.pods.map((p) => p.h))];
    assert.equal(heights.length, 2, "the row with a worker is taller than the rest");
    assert.equal(layout.pods.find((p) => p.supervisorId === "s5")!.h, Math.max(...heights));

    const rects = layout.seats.map((s) => ({ x: s.x, y: s.y, ...STATION[s.size] }));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) assert.ok(!overlaps(rects[a]!, rects[b]!), `${layout.seats[a]!.agentId} overlaps ${layout.seats[b]!.agentId}`);
    }
    for (const pod of layout.pods) {
      for (const desk of pod.spareDesks) assert.ok(desk.y + STATION.small.h <= pod.y + pod.h, `a spare desk spills out of ${pod.id}`);
    }
    assert.equal(layout.pods.find((p) => p.supervisorId === "s5")!.spareDesks.length, 1, "the worker's row has its desks");
    assert.equal(layout.pods.find((p) => p.supervisorId === "s0")!.spareDesks.length, 0);
    const room = layout.meetingRoom;
    assert.ok(layout.pods.every((p) => p.y + p.h <= room.y), "the meeting room is under the hall");
    assert.ok(room.y + room.h <= layout.height);
    assert.ok(layout.height < 1300, `${layout.height} is too tall to fit a screen`);
  });

  it("seats a meeting along the table, the chair in the middle, closing up so the whole office fits", () => {
    const room = layoutOffice([chief], 16).meetingRoom;
    const table = meetingTable(room);
    const few = meetingSeats(room, "chief", ["a", "b"]);
    assert.deepEqual(few.map((seat) => seat.agentId), ["a", "chief", "b"]);

    const everyone = Array.from({ length: 16 }, (_, index) => `s${index}`);
    const seats = meetingSeats(room, "chief", everyone);
    assert.equal(seats.length, 17);
    assert.equal(seats[8]!.agentId, "chief");
    assert.ok(seats[0]!.scale < few[0]!.scale, "a full table seats people closer and smaller");
    const heads = seats.map((seat) => ({ x: seat.x + 50 * seat.scale, r: 16 * seat.scale }));
    for (let index = 1; index < heads.length; index++) assert.ok(heads[index]!.x - heads[index - 1]!.x > heads[index]!.r * 2.4, "heads keep apart");
    assert.ok(heads[0]!.x >= table.left && heads.at(-1)!.x <= table.right);
    assert.ok(seats.every((seat) => seat.y >= room.y && seat.y + 70 * seat.scale === table.y));
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

describe("items that need the operator", () => {
  const items = [
    item(1, { urgency: "fyi" }),
    item(2, { urgency: "urgent", responsibilityId: "portfolio", state: "new" }),
    item(3, { urgency: "today", state: "new" }),
    item(4, { urgency: "today", state: "open" }),
    item(5, { state: "resolved", updatedAt: "2026-11-07T17:00:00.000Z" }),
    item(6, { state: "dismissed", updatedAt: "2026-11-07T18:00:00.000Z" }),
  ];

  it("lists the items waiting for the operator, most pressing first", () => {
    assert.deepEqual(itemsWaiting(items).map((i) => i.id), [2, 3, 4, 1]);
  });

  it("lists closed items newest first and counts the open ones", () => {
    assert.deepEqual(closedItems(items).map((i) => i.id), [6, 5]);
    assert.deepEqual(openCount(items), { open: 4, fresh: 2, urgent: 1 });
    const counts = openItemCounts(items);
    assert.deepEqual(counts.get("schedule"), { count: 3, fresh: 1, top: "today" });
    assert.deepEqual(counts.get("portfolio"), { count: 1, fresh: 1, top: "urgent" });
  });

  it("leaves out items that are only worth knowing, open or closed", () => {
    const news = [item(7, { needsOperator: false, urgency: "urgent", responsibilityId: "news", state: "new" }), item(8, { needsOperator: false, responsibilityId: "news", state: "resolved" })];
    const all = [...items, ...news];
    assert.deepEqual(itemsWaiting(all).map((i) => i.id), [2, 3, 4, 1]);
    assert.deepEqual(closedItems(all).map((i) => i.id), [6, 5]);
    assert.deepEqual(openCount(all), { open: 4, fresh: 2, urgent: 1 });
    assert.equal(openItemCounts(all).has("news"), false);
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
