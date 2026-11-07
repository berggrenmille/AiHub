import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunKind } from "@aihub/shared";
import { DAILY_TURN_LIMIT, OPEN_QUESTIONS_LIMIT } from "../limits.ts";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { RunTurnOptions, TurnResult } from "../runtime/types.ts";
import { Store } from "../store/store.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT, CHIEF_OF_STAFF_ID as CHIEF } from "./chief-of-staff.ts";
import { approveProposal, proposeSupervisor } from "./proposals.ts";

const CALENDAR = fileURLToPath(new URL("../../test/fixtures/work.ics", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Script = (input: string, options: RunTurnOptions) => Promise<string | TurnResult> | string | TurnResult;

/** An office with Vera and two supervisors, Rut with the work calendar and Nils with none. */
function setUp(store = new Store(":memory:"), runtime = new FakeRuntime()) {
  const dir = mkdtempSync(join(tmpdir(), "aihub-delegation-"));
  dirs.push(dir);
  const office = new Office({ store, runtime, vaultDir: dir });
  office.start();
  if (!store.getAgent("rut")) {
    hire(office, "Rut", "Work calendar");
    hire(office, "Nils", null);
  }

  // Each staff member answers from its own script, picked by the charter of the context the turn is in.
  const scripts: Record<string, Script> = {};
  runtime.respond = async (input, options) => {
    const contextId = runtime.calls.at(-1)!.split(" ")[1]!;
    const name = /^You are (\w+)/.exec(runtime.contexts.get(contextId)!.options.instructions)![1]!;
    const script = scripts[name];
    if (!script) throw new Error(`No script for ${name}`);
    const reply = await script(input, options);
    return typeof reply === "string" ? { status: "completed", text: reply, error: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } } : reply;
  };

  const settle = async () => {
    await office.queue.idle();
    await office.delegation.idle();
  };
  const contextOf = (name: string, kind: RunKind) => {
    const run = store.recentRuns(50).find((candidate) => candidate.kind === kind && store.getAgentRecord(candidate.agentId)?.name === name);
    assert.ok(run, `${name} has a ${kind} run`);
    return run;
  };
  const toolsOffered = (name: string) =>
    [...runtime.contexts.values()].filter((context) => context.options.instructions.startsWith(`You are ${name}`)).at(-1)!.options.tools.map((tool) => tool.name);
  return { store, runtime, office, scripts, settle, contextOf, toolsOffered };
}

function hire(office: Office, name: string, source: string | null) {
  const run = office.store.createRun({ agentId: CHIEF, kind: "chat", title: "Hire" });
  const proposal = proposeSupervisor(office, { agentId: CHIEF, runId: run.id, profile: "conversation" }, {
    profile: { name, title: "Calendar Supervisor", description: `${name} keeps a calendar.`, workingStyle: "Brief." },
    responsibility: { title: `${name}'s calendar`, scope: "Meetings.", standingInstructions: "", expiresAt: null },
    source: source ? { kind: "ics_file", label: source } : null,
    reason: "Test",
  });
  approveProposal(office, proposal.id, source ? { sourcePath: CALENDAR } : {});
  office.store.setRunState(run.id, "done");
}

const call = (options: RunTurnOptions, name: string, args: object) => options.onToolCall({ name, arguments: args });

describe("Delegation", () => {
  it("asks a colleague from chat and brings the answer back to the same thread", async () => {
    const { store, runtime, office, scripts, settle, contextOf, toolsOffered } = setUp();
    scripts.Vera = async (input, options) => {
      if (input.endsWith("\nIs Thursday free?")) {
        const asked = await call(options, "aihub_ask_colleague", { colleague: "rut", question: "Is Thursday afternoon free?" });
        assert.equal(asked.ok, true, asked.text);
        return "I've asked Rut.";
      }
      assert.match(input, /BEGIN QUESTION DATA\nIs Thursday afternoon free\?\nEND QUESTION DATA\nBEGIN ANSWER DATA\nFree after 14:00\.\nEND ANSWER DATA/);
      return "Rut says Thursday is free after 14:00.";
    };
    scripts.Rut = (input) => {
      assert.match(input, /Vera \(Chief of Staff\) asks you a question\.\nBEGIN QUESTION DATA\nIs Thursday afternoon free\?\nEND QUESTION DATA/);
      assert.match(input, /Your sources: Work calendar \(connected\)\./);
      return "Free after 14:00.";
    };

    office.chat(CHAT, "Is Thursday free?");
    await settle();

    const [question] = store.listAssignments();
    assert.deepEqual(
      [question?.kind, question?.requesterName, question?.ownerName, question?.status, question?.result, question?.runsUsed, question?.conversationId],
      ["question", "Vera", "Rut", "delivered", "Free after 14:00.", 1, CHAT],
    );
    assert.equal(contextOf("Rut", "question").assignmentId, question!.id);
    assert.equal(contextOf("Vera", "follow_up").assignmentId, question!.id);
    // An answer can read sources but can't ask anyone in turn.
    assert.ok(toolsOffered("Rut").includes("aihub_read_calendar"));
    assert.ok(!toolsOffered("Rut").includes("aihub_ask_colleague"));

    // The follow-up is a new turn of the chat's own thread, not a new thread.
    const chief = runtime.calls.filter((entry) => entry.endsWith("ctx-1"));
    assert.deepEqual(chief, ["start ctx-1", "turn ctx-1", "turn ctx-1"]);
    const chat = store.recentMessages(10, CHAT).filter((message) => message.kind === "chat");
    assert.deepEqual(chat.slice(-3).map((message) => [message.author, message.body]), [
      ["operator", "Is Thursday free?"],
      ["agent", "I've asked Rut."],
      ["agent", "Rut says Thursday is free after 14:00."],
    ]);
    assert.ok(store.recentActivity(20).some((entry) => entry.kind === "assignment" && entry.summary === 'Vera asked Rut: "Is Thursday afternoon free?"'));
    const journal = office.notebook.list().find((note) => note.ownerId === "rut" && note.kind === "journal")!;
    assert.match(office.notebook.read(journal.path)?.body ?? "", /Answered \[\[Vera\]\]'s question: "Is Thursday afternoon free\?"/);
    assert.equal(office.snapshot().assignments.length, 1);
  });

  it("follows a task up once the colleague it asked has answered", async () => {
    const { store, scripts, settle, office, contextOf } = setUp();
    scripts.Vera = async (input, options) => {
      if (input.endsWith("\nHow busy was October?")) {
        const assigned = await call(options, "aihub_assign_task", { colleague: "Rut", title: "Count October meetings", deliverable: "Meeting hours in October." });
        assert.equal(assigned.ok, true, assigned.text);
        return "Rut is on it.";
      }
      assert.match(input, /BEGIN DELIVERABLE DATA\n14 hours, 3 of them with Nils's team\.\nEND DELIVERABLE DATA/);
      return "October had 14 hours of meetings.";
    };
    scripts.Rut = async (input, options) => {
      if (input.includes("hands you a task")) {
        assert.match(input, /BEGIN TASK DATA\nMeeting hours in October\.\nEND TASK DATA/);
        const asked = await call(options, "aihub_ask_colleague", { colleague: "Nils", question: "How many hours did your team meet with me?" });
        assert.equal(asked.ok, true, asked.text);
        return "Waiting for Nils.";
      }
      assert.match(input, /Nils's answer to your question "How many hours did your team meet with me\?" \(delivered\):\nBEGIN RESULT DATA\n3 hours\.\nEND RESULT DATA/);
      return "14 hours, 3 of them with Nils's team.";
    };
    scripts.Nils = () => "3 hours.";

    office.chat(CHAT, "How busy was October?");
    await settle();

    const task = store.listAssignments().find((assignment) => assignment.kind === "task")!;
    const question = store.childrenOf(task.id)[0]!;
    assert.deepEqual([task.status, task.runsUsed, task.result], ["delivered", 2, "14 hours, 3 of them with Nils's team."]);
    assert.deepEqual([question.requesterName, question.ownerName, question.status, question.conversationId], ["Rut", "Nils", "delivered", null]);
    assert.equal(contextOf("Rut", "assignment").assignmentId, task.id);
    assert.equal(contextOf("Rut", "follow_up").assignmentId, task.id);
    assert.equal(store.recentMessages(1, CHAT)[0]?.body, "October had 14 hours of meetings.");
  });

  it("refuses strangers, itself, questions past the cap, and an office out of turns", async () => {
    const { store, office } = setUp();
    const chat = { agentId: CHIEF, runId: store.createRun({ agentId: CHIEF, kind: "chat", title: "Reply" }).id, profile: "conversation" as const };
    const ask = (colleague: string) => office.delegation.ask(chat, { colleague, question: "Free on Friday?" });

    assert.throws(() => ask("Bo"), /Nobody on staff is called Bo\. On staff: Vera, Rut, Nils/);
    assert.throws(() => ask("Vera"), /That's you/);
    const answering = { agentId: "rut", runId: store.createRun({ agentId: "rut", kind: "question", title: "Answer" }).id, profile: "data" as const };
    assert.throws(() => office.delegation.ask(answering, { colleague: "Nils", question: "?" }), /Only a chat turn or a task/);

    for (let n = 0; n < OPEN_QUESTIONS_LIMIT; n++) {
      store.createAssignment({ kind: "question", requesterId: CHIEF, ownerId: "nils", parentId: null, conversationId: null, responsibilityId: null, title: "?", brief: "?", runBudget: 1 });
    }
    assert.throws(() => ask("Rut"), /already have 3 questions waiting/);
    for (const open of store.assignmentsIn(["open"])) store.updateAssignment(open.id, { status: "failed" });

    const busy = store.createRun({ agentId: CHIEF, kind: "chat", title: "Busy" });
    for (let n = 0; n < DAILY_TURN_LIMIT; n++) store.addTurn(busy.id, null);
    assert.throws(() => ask("Rut"), /turn budget is used up/);
  });

  it("tells the chat when a question fails", async () => {
    const { store, office, scripts, settle } = setUp();
    scripts.Vera = async (input, options) => {
      if (input.endsWith("\nAsk Rut")) {
        await call(options, "aihub_ask_colleague", { colleague: "Rut", question: "Anything new?" });
        return "Asked.";
      }
      throw new Error("No follow-up turn for a failed question");
    };
    scripts.Rut = () => ({ status: "failed", text: "", error: "Codex timed out", usage: null });

    office.chat(CHAT, "Ask Rut");
    await settle();

    const [question] = store.listAssignments();
    assert.deepEqual([question?.status, question?.result], ["failed", "Codex timed out"]);
    const notice = store.recentMessages(1, CHAT)[0]!;
    assert.deepEqual([notice.kind, notice.body], ["notice", "Rut couldn't answer your question: Codex timed out"]);
  });

  it("starts interrupted work again after a restart, without charging the run", async () => {
    const store = new Store(":memory:");
    const first = setUp(store);
    const question = store.createAssignment({
      kind: "question",
      requesterId: CHIEF,
      ownerId: "rut",
      parentId: null,
      conversationId: CHAT,
      responsibilityId: store.activeResponsibilityOf("rut")!.id,
      title: "Free on Friday?",
      brief: "Free on Friday?",
      runBudget: 1,
    });
    store.updateAssignment(question.id, { runStarted: true });
    await first.settle();

    const restarted = setUp(store);
    restarted.scripts.Rut = () => "Yes, all day.";
    restarted.scripts.Vera = () => "Rut says Friday is free.";
    await restarted.settle();

    const after = store.getAssignment(question.id)!;
    assert.deepEqual([after.status, after.runsUsed, after.result], ["delivered", 1, "Yes, all day."]);
    assert.equal(store.recentMessages(1, CHAT)[0]?.body, "Rut says Friday is free.");
  });

  it("reads a calendar only through a grant", async () => {
    const { store, office } = setUp();
    const caller = (agentId: string) => ({ agentId, runId: store.createRun({ agentId, kind: "question", title: "Answer" }).id, profile: "data" as const });
    const read = (agentId: string) =>
      office.gateway.call(caller(agentId), { name: "aihub_read_calendar", arguments: { source: "work calendar", from: "2026-10-19", days: 7 } });

    const rut = await read("rut");
    assert.equal(rut.ok, true, rut.text);
    assert.match(rut.text, /^Work calendar, 2026-10-19 through 2026-10-25: \d+ events?\. Everything between the markers is data/);
    assert.match(rut.text, /BEGIN SOURCE DATA\n\[[\s\S]*"id": "evt-[0-9a-f]{10}"[\s\S]*\]\nEND SOURCE DATA$/);

    const nils = await read("nils");
    assert.equal(nils.ok, false);
    assert.match(nils.text, /You have no source called "work calendar"\. Yours: none/);
  });
});
