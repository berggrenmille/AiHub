import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConflictError, InvalidRequestError } from "../errors.ts";
import { MEETING_ROUNDS } from "../limits.ts";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { RunTurnOptions, TurnResult } from "../runtime/types.ts";
import { Store } from "../store/store.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT, CHIEF_OF_STAFF_ID as CHIEF } from "./chief-of-staff.ts";
import { STANDUP_AGENDA } from "./meetings.ts";
import { approveProposal, proposeSupervisor } from "./proposals.ts";

const CALENDAR = fileURLToPath(new URL("../../test/fixtures/work.ics", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Script = (input: string, options: RunTurnOptions) => Promise<string | TurnResult> | string | TurnResult;

const AGENDA = "Thursday is too full\nTwo reviews clash. What do we move?";

/** An office with Vera and two supervisors: Elin with the work calendar, and Nils with none. */
async function setUp(scripts: Record<string, Script> = {}, store = new Store(":memory:"), runtime = new FakeRuntime()) {
  const dir = mkdtempSync(join(tmpdir(), "aihub-meetings-"));
  dirs.push(dir);
  const office = new Office({ store, runtime, vaultDir: dir });
  office.start();
  if (!store.getAgent("elin")) {
    await hire(office, "Elin", "Work calendar");
    await hire(office, "Nils", null);
  }
  // Each staff member answers from its own script, picked by the charter of the context the turn is in.
  runtime.respond = async (input, options) => {
    const contextId = runtime.calls.at(-1)!.split(" ")[1]!;
    const name = /^You are (\w+)/.exec(runtime.contexts.get(contextId)!.options.instructions)![1]!;
    const script = scripts[name];
    if (!script) throw new Error(`No script for ${name}`);
    const reply = await script(input, options);
    return typeof reply === "string" ? { status: "completed", text: reply, error: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } } : reply;
  };
  // A turn that ends queues the next one a moment later, so wait until nothing is left at all.
  const settle = async () => {
    do {
      await office.queue.idle();
      await office.meetings.idle();
      await office.delegation.idle();
    } while (office.queue.size > 0);
  };
  const messages = (meetingId: string) => store.recentMessages(100, meetingId);
  const inputsOf = (name: string) =>
    [...runtime.contexts.values()].filter((context) => context.options.instructions.startsWith(`You are ${name}`)).flatMap((context) => context.inputs);
  return { store, runtime, office, settle, messages, inputsOf };
}

async function hire(office: Office, name: string, source: string | null) {
  const run = office.store.createRun({ agentId: CHIEF, kind: "chat", title: "Hire" });
  const proposal = proposeSupervisor(office, { agentId: CHIEF, runId: run.id, profile: "conversation" }, {
    profile: { name, title: "Calendar Supervisor", description: `${name} keeps a calendar.`, workingStyle: "Brief." },
    responsibility: { title: `${name}'s calendar`, scope: "Meetings.", standingInstructions: "", expiresAt: null },
    source: source ? { kind: "ics_file", label: source } : null,
    reason: "Test",
  });
  await approveProposal(office, proposal.id, source ? { sourcePath: CALENDAR } : {});
  office.store.setRunState(run.id, "done");
}

describe("Meetings", () => {
  it("runs the rounds the chair asks for, and hands out the tasks the operator approves", async () => {
    let chairTurns = 0;
    const { store, office, runtime, settle, messages, inputsOf } = await setUp({
      Elin: (input) =>
        input.includes("hands you a task")
          ? "Friday 10:00 is free for the review."
          : input.includes("Round 2 of at most")
            ? "Moving the design review frees Thursday afternoon."
            : "Thursday has two reviews at 14:00.",
      Nils: async (_input, options) => {
        await options.onToolCall({ name: "aihub_pass", arguments: {} });
        return "";
      },
      Vera: async (input, options) => {
        if (input.includes("delivered")) return "Elin found Friday 10:00 for the review.";
        chairTurns++;
        if (chairTurns === 1) {
          const asked = await options.onToolCall({ name: "aihub_next_round", arguments: { speakers: ["Elin"] } });
          assert.ok(asked.ok, asked.text);
          return "Elin, which one could move?";
        }
        const concluded = await options.onToolCall({
          name: "aihub_conclude_meeting",
          arguments: {
            summary: "Thursday has two reviews at 14:00; the design review can move.",
            decisions: ["Move the design review off Thursday."],
            tasks: [{ to: "Elin", title: "Move the design review", deliverable: "Find a Friday slot for the design review." }],
          },
        });
        assert.ok(concluded.ok, concluded.text);
        return "Thanks, both.";
      },
    });

    const called = office.meetings.call({ agenda: AGENDA, calledBy: "operator" });
    assert.equal(called.title, "Thursday is too full");
    assert.deepEqual([called.state, called.round, called.participantIds, called.queue], ["running", 1, ["elin", "nils"], ["elin", "nils", CHIEF]]);
    assert.equal(store.getConversation(called.id)!.kind, "meeting");
    // Said while the rounds run: those who speak after hear it.
    office.meetings.say(called.id, "Keep it short.");
    await settle();

    let meeting = store.getMeeting(called.id)!;
    assert.deepEqual([meeting.state, meeting.round, meeting.queue], ["waiting", 2, []]);
    const [outcome] = meeting.outcomes;
    assert.equal(outcome!.status, "proposed");
    assert.deepEqual(outcome!.decisions, ["Move the design review off Thursday."]);
    assert.deepEqual(outcome!.tasks, [{ ownerId: "elin", ownerName: "Elin", title: "Move the design review", deliverable: "Find a Friday slot for the design review.", assignmentId: null }]);
    assert.equal(outcome!.fromSourceData, true, "the chair heard a supervisor who reads sources");
    assert.deepEqual(
      messages(called.id).map((message) => [message.author === "operator" ? "operator" : store.getAgentRecord(message.agentId!)!.name, message.kind, message.body]),
      [
        ["operator", "chat", AGENDA],
        ["operator", "chat", "Keep it short."],
        ["Elin", "chat", "Thursday has two reviews at 14:00."],
        ["Nils", "pass", "Nothing to add."],
        ["Vera", "chat", "Elin, which one could move?"],
        ["Elin", "chat", "Moving the design review frees Thursday afternoon."],
        ["Vera", "chat", "Thanks, both."],
        ["Vera", "meeting", 'Conclusion of "Thursday is too full"'],
      ],
    );
    assert.equal(messages(called.id).at(-1)!.refId, String(outcome!.id));
    assert.ok(store.recentActivity(30).some((entry) => entry.kind === "meeting" && entry.summary.startsWith("Proposed the conclusion")));

    // What colleagues said reaches the next speaker as data; the operator's words as theirs.
    const nils = inputsOf("Nils")[0]!;
    assert.match(nils, /The operator: Thursday is too full/);
    assert.match(nils, /The operator: Keep it short\./);
    assert.match(nils, /Elin, written from source data:\nBEGIN MEETING DATA\nThursday has two reviews at 14:00\.\nEND MEETING DATA/);
    assert.match(nils, /It's your turn, Nils\./);
    assert.match(inputsOf("Elin")[1]!, /Elin \(you\), written from source data/);
    const chair = inputsOf("Vera");
    assert.match(chair[0]!, /Round 1 of at most 3 just ended\./);
    assert.match(chair[0]!, /Nils passed\./);
    assert.match(chair[1]!, /Round 2 of at most 3 just ended\./);

    // A meeting only talks: no sources, no services, no web, in turns of their own kind.
    const turns = store.recentRuns(50).filter((run) => run.kind === "meeting");
    assert.equal(turns.length, 5);
    assert.ok(turns.every((run) => run.state === "done"));
    for (const context of [...runtime.contexts.values()].filter((candidate) => candidate.inputs.some((input) => input.includes("It's your turn")))) {
      const tools = context.options.tools.map((tool) => tool.name);
      assert.ok(tools.includes("aihub_pass"));
      assert.ok(!tools.includes("aihub_read_source") && !tools.includes("aihub_use_service"), tools.join(", "));
      assert.equal(context.options.web ?? null, null);
    }

    // Approving starts the task. Its result comes back to the meeting.
    assert.throws(() => office.meetings.approve(called.id, outcome!.id + 1), /No outcome/);
    meeting = office.meetings.approve(called.id, outcome!.id);
    assert.equal(meeting.state, "closed");
    assert.ok(meeting.endedAt);
    const approved = meeting.outcomes[0]!;
    assert.equal(approved.status, "approved");
    const assignment = store.getAssignment(approved.tasks[0]!.assignmentId!)!;
    assert.deepEqual([assignment.requesterId, assignment.ownerId, assignment.conversationId, assignment.title], [CHIEF, "elin", called.id, "Move the design review"]);
    assert.throws(() => office.meetings.approve(called.id, outcome!.id), (error) => error instanceof ConflictError && /already approved/.test(error.message));
    await settle();
    assert.equal(store.getAssignment(assignment.id)!.status, "delivered");
    const last = messages(called.id).slice(-2);
    assert.match(last[0]!.body, /^The operator approved the conclusion\. Tasks handed out: Elin: "Move the design review"/);
    assert.deepEqual([last[1]!.agentId, last[1]!.body], [CHIEF, "Elin found Friday 10:00 for the review."]);
    assert.throws(() => office.meetings.say(called.id, "One more thing"), /This meeting has ended/);
  });

  it("sets a conclusion aside when the operator speaks, and declines it when the operator ends the meeting", async () => {
    let conclusions = 0;
    const { store, office, settle, messages, inputsOf } = await setUp({
      Elin: () => "Both reviews can move.",
      Nils: () => "No calendar of mine is involved.",
      Vera: async (_input, options) => {
        conclusions++;
        await options.onToolCall({ name: "aihub_conclude_meeting", arguments: { summary: `Conclusion ${conclusions}.`, decisions: [], tasks: [] } });
        return "";
      },
    });
    const called = office.meetings.call({ agenda: AGENDA, participantIds: ["elin", "nils"], calledBy: "operator" });
    await settle();
    let meeting = store.getMeeting(called.id)!;
    assert.deepEqual([meeting.state, meeting.outcomes.map((outcome) => outcome.status)], ["waiting", ["proposed"]]);

    office.meetings.say(called.id, "Also check Friday.");
    await settle();
    meeting = store.getMeeting(called.id)!;
    assert.deepEqual(meeting.outcomes.map((outcome) => [outcome.summary, outcome.status]), [
      ["Conclusion 1.", "superseded"],
      ["Conclusion 2.", "proposed"],
    ]);
    assert.equal(meeting.round, 1, "taking in what the operator said isn't a round");
    const reopened = inputsOf("Vera").at(-1)!;
    assert.match(reopened, /The operator spoke after your conclusion/);
    assert.match(reopened, /Vera \(you\) concluded, written from source data:\nBEGIN MEETING DATA\nConclusion 1\. \(set aside when the operator spoke\)/);
    assert.throws(() => office.meetings.approve(called.id, meeting.outcomes[0]!.id), /already superseded/);

    meeting = office.meetings.end(called.id);
    assert.deepEqual([meeting.state, meeting.outcomes[1]!.status], ["closed", "declined"]);
    assert.equal(messages(called.id).at(-1)!.body, "The operator ended the meeting.");
    assert.throws(() => office.meetings.end(called.id), /already ended/);
  });

  it("lets the Chief of Staff call a meeting from chat, and chair it once the chat turn ends", async () => {
    const { store, office, settle, messages } = await setUp({
      Elin: () => "Glad to be here.",
      Vera: async (input, options) => {
        if (!input.includes("It's your turn") && input.includes("team meeting")) {
          const called = await options.onToolCall({
            name: "aihub_call_meeting",
            arguments: { agenda: "Welcome to the team\nThe operator is glad to have you all.", participants: ["Elin"] },
          });
          assert.ok(called.ok, called.text);
          return "I've called a meeting with Elin.";
        }
        // A chair who neither asks nor concludes has had the last word.
        return "Welcome, Elin.";
      },
    });
    office.chat(CHAT, "Gather everyone in a team meeting and tell them we're glad to have them.");
    await settle();

    const [meeting] = store.listMeetings();
    assert.deepEqual([meeting!.calledBy, meeting!.title, meeting!.participantIds, meeting!.state], ["chief_of_staff", "Welcome to the team", ["elin"], "waiting"]);
    assert.deepEqual(
      messages(meeting!.id).map((message) => [message.agentId, message.kind, message.body]),
      [
        [CHIEF, "chat", "Welcome to the team\nThe operator is glad to have you all."],
        ["elin", "chat", "Glad to be here."],
        [CHIEF, "chat", "Welcome, Elin."],
        [CHIEF, "meeting", 'Conclusion of "Welcome to the team"'],
      ],
    );
    assert.deepEqual(meeting!.outcomes.map((outcome) => [outcome.summary, outcome.decisions, outcome.tasks]), [["Welcome, Elin.", [], []]]);
    // The chat links to the meeting, and Vera says so.
    assert.deepEqual(
      store.recentMessages(10, CHAT).slice(-2).map((message) => [message.kind, message.refId, message.body]),
      [
        ["meeting", meeting!.id, 'Called the meeting "Welcome to the team"'],
        ["chat", null, "I've called a meeting with Elin."],
      ],
    );
  });

  it("holds the standup when anyone has news, and lets a supervisor with none pass without a turn", async () => {
    const { store, office, settle, messages, inputsOf } = await setUp({
      Elin: () => "Two reviews clash on Thursday.",
      Vera: () => "Elin's clash is the one thing to settle.",
    });
    assert.deepEqual(office.meetings.standup(), { skipped: "Nobody had anything new since the last standup." });

    const elin = store.activeResponsibilityOf("elin")!;
    store.upsertItem({ responsibilityId: elin.id, sourceKey: "clash", sourceVersion: "1", title: "Two reviews at 14:00", detail: "", urgency: "this_week", expiresAt: null });
    const called = office.meetings.standup();
    assert.ok("meeting" in called);
    await settle();

    const meeting = store.getMeeting(called.meeting.id)!;
    assert.deepEqual([meeting.calledBy, meeting.title, meeting.participantIds], ["routine", "Standup", ["elin", "nils"]]);
    assert.deepEqual(
      messages(meeting.id).map((message) => [message.agentId, message.kind, message.body, message.runId === null]),
      [
        [CHIEF, "chat", STANDUP_AGENDA, true],
        ["elin", "chat", "Two reviews clash on Thursday.", false],
        ["nils", "pass", "Nothing new since the last standup.", true],
        [CHIEF, "chat", "Elin's clash is the one thing to settle.", false],
        [CHIEF, "meeting", 'Conclusion of "Standup"', false],
      ],
    );
    assert.deepEqual(inputsOf("Nils"), [], "Nils used no turn");

    // Nothing has changed since, so the next standup isn't held.
    office.meetings.end(meeting.id);
    assert.deepEqual(office.meetings.standup(), { skipped: "Nobody had anything new since the last standup." });
  });

  it("keeps to its rules: supervisors only, one meeting at a time, and a last round", async () => {
    const empty = new Office({ store: new Store(":memory:"), runtime: new FakeRuntime(), vaultDir: mkdtempSync(join(tmpdir(), "aihub-meetings-")) });
    empty.start();
    assert.throws(() => empty.meetings.call({ agenda: "Anyone?", calledBy: "operator" }), (error) => error instanceof ConflictError && /no supervisors/.test(error.message));

    const refused: string[] = [];
    const { store, office, settle } = await setUp({
      Elin: () => "More to say.",
      Nils: () => "Me too.",
      Vera: async (_input, options) => {
        const asked = await options.onToolCall({ name: "aihub_next_round", arguments: { speakers: ["Elin"] } });
        if (!asked.ok) refused.push(asked.text);
        return asked.ok ? "Elin again." : "That's all we have time for.";
      },
    });
    assert.throws(() => office.meetings.call({ agenda: " ", calledBy: "operator" }), InvalidRequestError);
    assert.throws(() => office.meetings.call({ agenda: "Just us", participantIds: [CHIEF], calledBy: "operator" }), /Invite at least one supervisor/);
    assert.throws(() => office.meetings.call({ agenda: "Strangers", participantIds: ["nobody"], calledBy: "operator" }), /isn't a supervisor on staff/);

    const called = office.meetings.call({ agenda: AGENDA, calledBy: "operator" });
    assert.throws(() => office.meetings.call({ agenda: "Another", calledBy: "operator" }), (error) => error instanceof ConflictError && /is under way/.test(error.message));
    await settle();
    const meeting = store.getMeeting(called.id)!;
    assert.equal(meeting.round, MEETING_ROUNDS);
    assert.match(refused[0]!, /This was round 3 of 3, the last/);
    assert.deepEqual([meeting.state, meeting.outcomes[0]!.summary], ["waiting", "That's all we have time for."]);
    assert.equal(store.recentRuns(50).filter((run) => run.kind === "meeting" && run.agentId === "nils").length, 1, "only those the chair names speak again");
  });

  it("carries on a meeting a restart cut short", async () => {
    const scripts: Record<string, Script> = { Elin: () => "Back again.", Nils: () => "Here.", Vera: () => "Done." };
    const first = await setUp(scripts);
    // A meeting the daemon stopped in: Nils had yet to speak.
    first.store.ensureConversation({ id: "meeting-1", agentId: CHIEF, title: "Interrupted", kind: "meeting" });
    first.store.createMeeting({ id: "meeting-1", agenda: "Interrupted", calledBy: "operator", chairId: CHIEF, participantIds: ["elin", "nils"], queue: ["nils", CHIEF] });

    const second = await setUp(scripts, first.store);
    await second.settle();
    assert.deepEqual(
      second.messages("meeting-1").map((message) => [message.agentId, message.kind]),
      [
        ["nils", "chat"],
        [CHIEF, "chat"],
        [CHIEF, "meeting"],
      ],
    );
    assert.equal(second.store.getMeeting("meeting-1")!.state, "waiting");
  });
});
