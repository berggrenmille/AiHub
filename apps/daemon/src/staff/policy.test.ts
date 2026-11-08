import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError, InvalidRequestError } from "../errors.ts";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import { Store } from "../store/store.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";
import { approvePolicy, declinePolicy, POLICY_LIMIT, writePolicy } from "./policy.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "aihub-policy-"));
  dirs.push(dir);
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime, vaultDir: dir });
  office.start();
  store.upsertAgent({ id: "nora", name: "Nora", title: "News Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
  const callerIn = (kind: "chat" | "follow_up", sourceData = false) => ({
    agentId: CHIEF_OF_STAFF_ID,
    runId: store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind, title: kind }).id,
    profile: "conversation" as const,
    sourceData,
  });
  const propose = (policy: string, reason = "You asked for it.", caller = callerIn("chat")) =>
    office.gateway.call(caller, { name: "aihub_propose_policy", arguments: { policy, reason } });
  /** The instructions of a task Nora runs now. */
  const noraSees = async () => {
    await office.runTask({ agentId: "nora", kind: "report", title: "Check", instructions: "Check.", input: "Nothing." });
    return [...runtime.contexts.values()].at(-1)!.options.instructions;
  };
  return { store, office, runtime, callerIn, propose, noraSees };
}

describe("The office policy", () => {
  it("applies the operator's policy to every staff member's runs", async () => {
    const { store, office, noraSees } = setUp();
    assert.doesNotMatch(await noraSees(), /Office policy/);

    const version = writePolicy(office, "- Write in English.\r\n- Never name my children.\n");
    assert.deepEqual([version.status, version.authorId, version.body], ["approved", null, "- Write in English.\n- Never name my children."]);
    assert.equal(store.currentPolicy()?.id, version.id);
    assert.match(
      await noraSees(),
      /^You are Nora, News Supervisor[\s\S]*\n\nOffice policy, from the operator\. It applies to every staff member, and only the operator changes it:\n- Write in English\.\n- Never name my children\.\n\n/,
    );
    assert.ok(store.recentActivity(5).some((entry) => entry.kind === "policy" && entry.summary === "The operator changed the office policy"));

    assert.throws(() => writePolicy(office, " - Write in English.\n- Never name my children. "), InvalidRequestError);
    assert.throws(() => writePolicy(office, "x".repeat(POLICY_LIMIT + 1)), /at most 4000 characters/);
    writePolicy(office, "");
    assert.doesNotMatch(await noraSees(), /Office policy/, "a cleared policy says nothing");
  });

  it("puts the Chief of Staff's proposal on a card, and applies it only once approved", async () => {
    const { store, office, propose, noraSees } = setUp();
    const base = writePolicy(office, "- Write in English.");
    const outcome = await propose("- Write in English.\n- Flag anything about money the same day.", "You asked me to flag money matters for everyone.");
    assert.equal(outcome.ok, true, outcome.text);

    const [proposal] = store.pendingPolicies();
    assert.deepEqual([proposal?.authorId, proposal?.basedOn, proposal?.fromSourceData], [CHIEF_OF_STAFF_ID, base.id, false]);
    const card = store.recentMessages(5, CHIEF_OF_STAFF_CONVERSATION_ID).find((message) => message.kind === "policy");
    assert.deepEqual([card?.refId, card?.body], [String(proposal!.id), "Policy proposal: You asked me to flag money matters for everyone."]);
    assert.doesNotMatch(await noraSees(), /money/, "nothing applies before approval");

    const approved = approvePolicy(office, proposal!.id);
    assert.equal(approved.status, "approved");
    assert.equal(store.currentPolicy()?.id, proposal!.id);
    assert.match(await noraSees(), /- Flag anything about money the same day\./);
    assert.match(store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]!.body, /^You approved the new office policy/);
    const journal = office.notebook.list().find((note) => note.ownerId === CHIEF_OF_STAFF_ID && note.kind === "journal")!;
    assert.match(office.notebook.read(journal.path)!.body, /approved my proposed office policy/);
    assert.throws(() => approvePolicy(office, proposal!.id), ConflictError);
  });

  it("keeps one proposal waiting, withdraws it when the operator edits, and records a decline", async () => {
    const { store, office, propose } = setUp();
    await propose("- One.");
    await propose("- One.\n- Two.", "Two rules after all.");
    const [first, second] = store.listPolicies().reverse();
    assert.deepEqual([first?.status, first?.outcome, second?.status], ["withdrawn", "Replaced by a newer proposal.", "pending"]);

    writePolicy(office, "- Mine.");
    assert.deepEqual([store.getPolicy(second!.id)?.status, store.getPolicy(second!.id)?.outcome], ["withdrawn", "You changed the policy yourself after this was proposed."]);
    assert.throws(() => approvePolicy(office, second!.id), ConflictError);

    await propose("- Mine.\n- Three.");
    const third = store.pendingPolicies()[0]!;
    const declined = declinePolicy(office, third.id, "Not yet");
    assert.deepEqual([declined.status, declined.outcome], ["declined", "Not yet"]);
    assert.equal(store.currentPolicy()?.body, "- Mine.");
    assert.equal(store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]!.body, "You declined the policy proposal: Not yet");
  });

  it("refuses a proposal from a follow-up or a supervisor, and marks one drafted from source data", async () => {
    const { store, propose, callerIn, office } = setUp();
    assert.match((await propose("- One.", "x", callerIn("follow_up"))).text, /not available to this run/);
    const nora = { agentId: "nora", runId: store.createRun({ agentId: "nora", kind: "chat", title: "chat" }).id, profile: "data" as const };
    assert.equal((await office.gateway.call(nora, { name: "aihub_propose_policy", arguments: { policy: "- One.", reason: "x" } })).ok, false);
    assert.match((await propose("")).text, /current policy word for word/);

    assert.equal((await propose("- One.", "From the briefing", callerIn("chat", true))).ok, true);
    assert.equal(store.pendingPolicies()[0]?.fromSourceData, true);
    assert.equal(store.messagesAfter(CHIEF_OF_STAFF_CONVERSATION_ID, 0).at(-1)?.sourceData, true);
  });
});
