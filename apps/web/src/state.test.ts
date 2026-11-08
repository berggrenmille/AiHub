import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEntry, Agent, Assignment, ChatMessage, DaemonEvent, Item, NoteSummary, PolicyVersion, Proposal, Responsibility, Run, StaffChange, StaffReader, StateSnapshot, View } from "@aihub/shared";
import { ACTIVITY_LIMIT, initialOfficeState, officeReducer, rosterOrder, SETTLED_ASSIGNMENT_LIMIT, type OfficeAction, type OfficeState } from "./state.ts";

const CHAT = "chief-of-staff";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "chief-of-staff",
    name: "Vera",
    title: "Chief of Staff",
    description: "Runs the office.",
    workingStyle: "Brief.",
    avatar: "chief-of-staff",
    hiredAt: "2026-11-07T16:00:00.000Z",
    experience: 0,
    connectionIds: [],
    web: null,
    model: null,
    effort: null,
    role: "chief_of_staff",
    managerId: null,
    profile: "conversation",
    state: "idle",
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    agentId: "chief-of-staff",
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

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    conversationId: CHAT,
    author: "operator",
    agentId: null,
    kind: "chat",
    body: "Hello",
    runId: "run-1",
    refId: null,
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
    responsibilities: [],
    connections: [],
    routines: [],
    proposals: [],
    items: [],
    assignments: [],
    readers: [],
    policies: [],
    staffChanges: [],
    notes: [],
    views: [],
    office: { turnsToday: 0, dailyTurnLimit: 80, activeSupervisors: 0, supervisorLimit: 8, briefingStreak: 0, staffReviewAt: null },
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

function responsibility(overrides: Partial<Responsibility> = {}): Responsibility {
  return {
    id: "resp-1",
    ownerId: "work-schedule",
    title: "Work schedule",
    scope: "The work calendar.",
    standingInstructions: "",
    expiresAt: null,
    status: "active",
    endedAt: null,
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    kind: "recruit_supervisor",
    proposedBy: "chief-of-staff",
    payload: {
      profile: { name: "Rut", title: "Bookkeeping Supervisor", description: "Keeps the books.", workingStyle: "Careful." },
      responsibility: { title: "Bookkeeping", scope: "Bank exports.", standingInstructions: "", expiresAt: null },
      source: { kind: "ics_file", label: "Bank export" },
      reason: "You asked.",
    },
    status: "pending",
    outcome: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 1,
    responsibilityId: "resp-1",
    sourceKey: "event-1",
    title: "Planning moved",
    detail: "Now at 10:00.",
    urgency: "today",
    needsOperator: true,
    state: "new",
    firstSeenAt: "2026-11-07T16:00:00.000Z",
    lastReportedAt: null,
    resolution: null,
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    path: "Office/Operator preferences.md",
    title: "Operator preferences",
    ownerId: null,
    kind: "office",
    provenance: "operator",
    links: [],
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

describe("office records", () => {
  it("loads responsibilities, connections, routines, proposals, items, notes and stats from the snapshot", () => {
    const office = { turnsToday: 12, dailyTurnLimit: 80, activeSupervisors: 2, supervisorLimit: 8, briefingStreak: 3, staffReviewAt: null };
    const state = apply(initialOfficeState, {
      type: "snapshot",
      snapshot: snapshot({
        responsibilities: [responsibility()],
        connections: [{ id: "conn-1", kind: "ics_file", label: "Work calendar", path: "C:/work.ics", pattern: null, reader: null, status: "connected", detail: "12 events", verifiedAt: null }],
        routines: [{ id: "routine-1", ownerId: "work-schedule", responsibilityId: "resp-1", title: "Check", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4, paused: false, nextRunAt: null }],
        proposals: [proposal({ id: "old", createdAt: "2026-11-06T09:00:00.000Z" }), proposal({ id: "new" })],
        items: [item()],
        notes: [note()],
        office,
      }),
    });
    assert.equal(state.responsibilities.length, 1);
    assert.equal(state.connections[0]?.label, "Work calendar");
    assert.equal(state.routines[0]?.id, "routine-1");
    assert.deepEqual(state.proposals.map((p) => p.id), ["new", "old"]);
    assert.equal(state.items.length, 1);
    assert.equal(state.notes.length, 1);
    assert.deepEqual(state.office, office);
  });

  it("upserts responsibilities, connections and routines by id", () => {
    let state = events(loaded(), { type: "responsibility", responsibility: responsibility() });
    state = events(state, { type: "responsibility", responsibility: responsibility({ status: "ended", endedAt: "2026-11-07T18:00:00.000Z" }) });
    assert.equal(state.responsibilities.length, 1);
    assert.equal(state.responsibilities[0]?.status, "ended");

    const connection = { id: "conn-1", kind: "ics_file" as const, label: "Work calendar", path: "C:/work.ics", pattern: null, reader: null, status: "unverified" as const, detail: null, verifiedAt: null };
    state = events(state, { type: "connection", connection }, { type: "connection", connection: { ...connection, status: "failed", detail: "Not found" } });
    assert.deepEqual(state.connections.map((c) => [c.id, c.status]), [["conn-1", "failed"]]);

    const routine = { id: "r-1", ownerId: "work-schedule", responsibilityId: null, title: "Check", trigger: { type: "weekdays" as const, time: "07:00" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4, paused: false, nextRunAt: null };
    state = events(state, { type: "routine", routine }, { type: "routine", routine: { ...routine, paused: true } }, { type: "routine", routine: { ...routine, id: "r-2" } });
    assert.deepEqual(state.routines.map((r) => [r.id, r.paused]), [["r-1", true], ["r-2", false]]);
  });

  it("keeps proposals newest first and never reopens a decided one", () => {
    let state = events(loaded(), { type: "proposal", proposal: proposal({ id: "a", createdAt: "2026-11-07T09:00:00.000Z" }) }, { type: "proposal", proposal: proposal({ id: "b" }) });
    assert.deepEqual(state.proposals.map((p) => p.id), ["b", "a"]);
    const approved = proposal({ id: "b", status: "approved", outcome: "Hired Rut", decidedAt: "2026-11-07T16:05:00.000Z" });
    state = events(state, { type: "proposal", proposal: approved });
    assert.equal(state.proposals[0]?.status, "approved");
    // A late copy from before the decision changes nothing.
    assert.equal(events(state, { type: "proposal", proposal: proposal({ id: "b" }) }), state);
  });

  it("ignores an item update older than the one it has", () => {
    let state = events(loaded(), { type: "item", item: item() });
    state = events(state, { type: "item", item: item({ state: "resolved", resolution: "Done", updatedAt: "2026-11-07T17:00:00.000Z" }) });
    assert.equal(state.items[0]?.state, "resolved");
    assert.equal(events(state, { type: "item", item: item({ state: "open", updatedAt: "2026-11-07T16:30:00.000Z" }) }), state);
    state = events(state, { type: "item", item: item({ id: 2, sourceKey: "event-2" }) });
    assert.deepEqual(state.items.map((i) => i.id), [1, 2]);
  });

  it("upserts notes by path and drops the old path when a profile note is renamed", () => {
    const profile = note({ path: "Staff/work-schedule/Elin.md", title: "Elin", ownerId: "work-schedule", kind: "profile", provenance: "aihub" });
    const topic = note({ path: "Staff/work-schedule/Anna.md", title: "Anna", ownerId: "work-schedule", kind: "topic", provenance: "source_data" });
    let state = events(loaded(), { type: "note", note: note() }, { type: "note", note: profile }, { type: "note", note: topic });
    assert.equal(state.notes.length, 3);

    state = events(state, { type: "note", note: note({ links: ["Elin"], updatedAt: "2026-11-07T17:00:00.000Z" }) });
    assert.equal(state.notes.length, 3);
    assert.deepEqual(state.notes.find((n) => n.kind === "office")?.links, ["Elin"]);
    assert.equal(events(state, { type: "note", note: note({ links: [] }) }), state, "an older copy is ignored");

    state = events(state, { type: "note", note: { ...profile, path: "Staff/work-schedule/Elina.md", title: "Elina", updatedAt: "2026-11-07T18:00:00.000Z" } });
    assert.deepEqual(state.notes.map((n) => n.path).sort(), ["Office/Operator preferences.md", "Staff/work-schedule/Anna.md", "Staff/work-schedule/Elina.md"]);
  });

  it("replaces the office stats", () => {
    const office = { turnsToday: 40, dailyTurnLimit: 80, activeSupervisors: 4, supervisorLimit: 8, briefingStreak: 5, staffReviewAt: null };
    assert.deepEqual(events(loaded(), { type: "office", office }).office, office);
  });

  it("ignores event types from a newer daemon", () => {
    const state = loaded();
    assert.equal(events(state, { type: "surprise" } as unknown as DaemonEvent), state);
  });
});

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "asg-1",
    kind: "question",
    requesterId: "chief-of-staff",
    requesterName: "Vera",
    ownerId: "work-schedule",
    ownerName: "Nora",
    parentId: null,
    conversationId: CHAT,
    title: "Room next week?",
    brief: "Is there room for a two-hour workshop next week?",
    status: "open",
    runBudget: 3,
    runsUsed: 0,
    result: null,
    review: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

describe("assignments", () => {
  it("loads them from the snapshot, open ones first, then the most recently settled", () => {
    const state = apply(initialOfficeState, {
      type: "snapshot",
      snapshot: snapshot({
        assignments: [
          assignment({ id: "settled-old", status: "delivered", updatedAt: "2026-11-07T16:10:00.000Z" }),
          assignment({ id: "open-old", createdAt: "2026-11-07T15:00:00.000Z" }),
          assignment({ id: "settled-new", status: "accepted", updatedAt: "2026-11-07T16:20:00.000Z" }),
          assignment({ id: "waiting-new", kind: "task", status: "waiting", createdAt: "2026-11-07T15:30:00.000Z" }),
        ],
      }),
    });
    assert.deepEqual(state.assignments.map((a) => a.id), ["waiting-new", "open-old", "settled-new", "settled-old"]);
  });

  it("upserts them from events in the same order, ignoring older copies", () => {
    let state = events(
      loaded(),
      { type: "assignment", assignment: assignment({ id: "a", createdAt: "2026-11-07T16:00:00.000Z" }) },
      { type: "assignment", assignment: assignment({ id: "b", createdAt: "2026-11-07T16:05:00.000Z", updatedAt: "2026-11-07T16:05:00.000Z" }) },
    );
    assert.deepEqual(state.assignments.map((a) => a.id), ["b", "a"]);

    // Delivered, "b" moves below the open "a" and above older settled work.
    const delivered = assignment({ id: "b", status: "delivered", result: "Thursday is free.", runsUsed: 1, updatedAt: "2026-11-07T16:09:00.000Z" });
    state = events(state, { type: "assignment", assignment: delivered });
    assert.deepEqual(state.assignments.map((a) => [a.id, a.status]), [
      ["a", "open"],
      ["b", "delivered"],
    ]);
    state = events(state, { type: "assignment", assignment: assignment({ id: "c", status: "failed", updatedAt: "2026-11-07T16:01:00.000Z" }) });
    assert.deepEqual(state.assignments.map((a) => a.id), ["a", "b", "c"]);

    // A copy from before delivery changes nothing.
    assert.equal(events(state, { type: "assignment", assignment: assignment({ id: "b", createdAt: "2026-11-07T16:05:00.000Z", updatedAt: "2026-11-07T16:05:00.000Z" }) }), state);
    assert.equal(state.assignments.find((a) => a.id === "b")?.result, "Thursday is free.");
  });

  it("keeps every open assignment and the most recent settled ones", () => {
    let state = events(loaded(), { type: "assignment", assignment: assignment({ id: "open" }) });
    for (let index = 0; index < SETTLED_ASSIGNMENT_LIMIT + 3; index++) {
      const at = new Date(Date.parse("2026-11-07T17:00:00.000Z") + index * 1000).toISOString();
      state = events(state, { type: "assignment", assignment: assignment({ id: `done-${index}`, status: "accepted", updatedAt: at }) });
    }
    assert.equal(state.assignments.length, SETTLED_ASSIGNMENT_LIMIT + 1);
    assert.equal(state.assignments[0]?.id, "open");
    assert.equal(state.assignments[1]?.id, `done-${SETTLED_ASSIGNMENT_LIMIT + 2}`);
    assert.ok(!state.assignments.some((a) => a.id === "done-0"));
  });
});

describe("staff leaving", () => {
  const worker = agent({ id: "worker-1", name: "Ture", title: "Meeting Counter", role: "worker", managerId: "work-schedule", avatar: "ture" });

  it("removes an agent that leaves and keeps the rest in order", () => {
    const supervisor = agent({ id: "work-schedule", name: "Nora", role: "supervisor", managerId: "chief-of-staff" });
    let state = events(loaded(), { type: "agent", agent: supervisor }, { type: "agent", agent: worker });
    assert.deepEqual(state.agents.map((a) => a.id), ["chief-of-staff", "work-schedule", "worker-1"]);
    state = events(state, { type: "agent_left", agentId: "worker-1" });
    assert.deepEqual(state.agents.map((a) => a.id), ["chief-of-staff", "work-schedule"]);
    assert.equal(events(state, { type: "agent_left", agentId: "worker-1" }), state, "leaving twice changes nothing");
  });

  it("doesn't bring back a departed agent on a late update, until a snapshot says so", () => {
    let state = events(loaded(), { type: "agent", agent: worker }, { type: "agent_left", agentId: "worker-1" });
    const left = state;
    state = events(state, { type: "agent", agent: { ...worker, state: "idle", experience: 1 } });
    assert.equal(state, left);

    state = apply(state, { type: "snapshot", snapshot: snapshot({ agents: [agent(), worker] }) });
    assert.deepEqual(state.departed, []);
    assert.ok(state.agents.some((a) => a.id === "worker-1"));
  });
});

function staffReader(overrides: Partial<StaffReader> = {}): StaffReader {
  return {
    id: "reader-1",
    name: "Bank export",
    format: "One transaction per line.",
    pattern: "*.txt",
    sampleNames: ["sample.txt"],
    status: "drafting",
    code: null,
    notes: null,
    authorId: "ada",
    authorName: "Ada",
    requesterId: "chief-of-staff",
    assignmentId: "asg-1",
    approvedAt: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

describe("readers", () => {
  it("loads them from the snapshot, newest first", () => {
    const state = apply(initialOfficeState, {
      type: "snapshot",
      snapshot: snapshot({ readers: [staffReader({ id: "old", createdAt: "2026-11-06T09:00:00.000Z" }), staffReader({ id: "new" })] }),
    });
    assert.deepEqual(state.readers.map((r) => r.id), ["new", "old"]);
  });

  it("upserts them by id as they move along, ignoring older copies", () => {
    let state = events(loaded(), { type: "reader", reader: staffReader() });
    const handedIn = staffReader({ status: "proposed", code: "function read(file) { return []; }", notes: "One per line.", updatedAt: "2026-11-07T16:06:00.000Z" });
    state = events(state, { type: "reader", reader: handedIn });
    assert.deepEqual(state.readers.map((r) => [r.id, r.status]), [["reader-1", "proposed"]]);
    assert.equal(state.readers[0]?.code, handedIn.code);

    assert.equal(events(state, { type: "reader", reader: staffReader() }), state, "the drafting copy is older");

    state = events(state, { type: "reader", reader: staffReader({ id: "reader-2", name: "Payslips", createdAt: "2026-11-07T17:00:00.000Z" }) });
    assert.deepEqual(state.readers.map((r) => r.id), ["reader-2", "reader-1"]);
  });
});

function policyVersion(overrides: Partial<PolicyVersion> = {}): PolicyVersion {
  return {
    id: 1,
    body: "- Write to me in English.",
    authorId: "chief-of-staff",
    reason: "You asked for English.",
    basedOn: null,
    status: "pending",
    fromSourceData: false,
    outcome: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

describe("the office policy", () => {
  it("loads its versions from the snapshot, newest first", () => {
    const state = apply(initialOfficeState, { type: "snapshot", snapshot: snapshot({ policies: [policyVersion({ id: 1 }), policyVersion({ id: 2 })] }) });
    assert.deepEqual(state.policies.map((p) => p.id), [2, 1]);
  });

  it("upserts versions as they are decided, and keeps a decision over a late copy of the proposal", () => {
    let state = events(loaded(), { type: "policy", policy: policyVersion() });
    const approved = policyVersion({ status: "approved", decidedAt: "2026-11-08T10:05:00.000Z" });
    state = events(state, { type: "policy", policy: approved });
    assert.deepEqual(state.policies.map((p) => [p.id, p.status]), [[1, "approved"]]);

    assert.equal(events(state, { type: "policy", policy: policyVersion() }), state);

    state = events(state, { type: "policy", policy: policyVersion({ id: 2, basedOn: 1 }) });
    assert.deepEqual(state.policies.map((p) => p.id), [2, 1]);
  });
});

describe("staff changes", () => {
  const change = (overrides: Partial<StaffChange> = {}): StaffChange => ({
    id: 1,
    agentId: "work-schedule",
    agentName: "Nora",
    responsibilityId: "r-1",
    responsibilityTitle: "Work calendar",
    change: { kind: "end" },
    reason: "Nothing found in weeks.",
    proposedBy: "chief-of-staff",
    runId: "run-review",
    fromSourceData: false,
    status: "pending",
    outcome: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
    ...overrides,
  });

  it("takes them from the snapshot, newest first, and keeps a decision over a late copy", () => {
    let state = apply(initialOfficeState, { type: "snapshot", snapshot: snapshot({ staffChanges: [change(), change({ id: 2 })] }) });
    assert.deepEqual(state.staffChanges.map((c) => c.id), [2, 1]);
    const approved = change({ status: "approved", decidedAt: "2026-11-08T10:05:00.000Z", outcome: "Nora left the office." });
    state = events(state, { type: "staff_change", change: approved });
    assert.deepEqual(state.staffChanges.map((c) => [c.id, c.status]), [[2, "pending"], [1, "approved"]]);
    assert.equal(events(state, { type: "staff_change", change: change() }), state);
  });
});

describe("conversations", () => {
  const nora = { id: "chat-work-schedule", agentId: "work-schedule", title: "Nora" };

  it("adds a conversation once, whether the stream or the response to opening it comes first", () => {
    const state = events(loaded(), { type: "conversation", conversation: nora });
    assert.deepEqual(state.conversations.map((c) => c.id), [CHAT, nora.id]);
    assert.equal(events(state, { type: "conversation", conversation: { ...nora } }), state);
  });

  it("takes a changed title", () => {
    const state = events(loaded(), { type: "conversation", conversation: nora }, { type: "conversation", conversation: { ...nora, title: "Nora Lind" } });
    assert.deepEqual(state.conversations.map((c) => [c.id, c.title]), [
      [CHAT, "Chief of Staff"],
      [nora.id, "Nora Lind"],
    ]);
  });

  it("keeps a departed staff member's conversation and messages", () => {
    const worker = agent({ id: "ada", name: "Ada", role: "worker", managerId: "chief-of-staff" });
    const chat = { id: "chat-ada", agentId: "ada", title: "Ada" };
    const state = events(
      loaded(),
      { type: "agent", agent: worker },
      { type: "conversation", conversation: chat },
      { type: "message", message: message({ id: 11, conversationId: chat.id }) },
      { type: "agent_left", agentId: "ada" },
    );
    assert.ok(!state.agents.some((a) => a.id === "ada"));
    assert.ok(state.conversations.some((c) => c.id === chat.id));
    assert.deepEqual(state.messages[chat.id]?.map((m) => m.id), [11]);
  });
});

describe("views", () => {
  const view = (overrides: Partial<View> = {}): View => ({
    id: "view-1",
    kind: "dashboard",
    agentId: "chief-of-staff",
    runId: "run-1",
    messageId: null,
    title: "Open items",
    program: 'root = Stack([Text("Hi")])',
    outside: "ask",
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  });

  it("loads them from the snapshot by id", () => {
    const state = apply(initialOfficeState, { type: "snapshot", snapshot: snapshot({ views: [view(), view({ id: "view-2", kind: "reply", messageId: 4 })] }) });
    assert.deepEqual(Object.keys(state.views).sort(), ["view-1", "view-2"]);
  });

  it("upserts them, ignores older copies, and drops a removed dashboard", () => {
    let state = events(loaded(), { type: "view", view: view() }, { type: "view", view: view({ title: "Items", updatedAt: "2026-11-07T17:00:00.000Z" }) });
    assert.equal(state.views["view-1"]?.title, "Items");
    assert.equal(events(state, { type: "view", view: view({ title: "Old" }) }), state);
    state = events(state, { type: "view_removed", viewId: "view-1" });
    assert.deepEqual(state.views, {});
    assert.equal(events(state, { type: "view_removed", viewId: "view-1" }), state);
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
