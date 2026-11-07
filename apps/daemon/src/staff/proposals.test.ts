import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConflictError, InvalidRequestError } from "../errors.ts";
import { SUPERVISOR_LIMIT } from "../limits.ts";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import { Store } from "../store/store.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./chief-of-staff.ts";
import { approveProposal, declineProposal } from "./proposals.ts";

const CALENDAR = fileURLToPath(new URL("../../test/fixtures/work.ics", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUT = {
  profile: { name: "Rut", title: "Calendar Supervisor", description: "Watches the family calendar.", workingStyle: "Brief." },
  responsibility: { title: "Family calendar", scope: "School and activities.", standingInstructions: "Always flag pickups after 17:00." },
  source: { kind: "ics_file", label: "Family calendar" },
  reason: "You asked for help with the family calendar.",
};

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "aihub-proposals-"));
  dirs.push(dir);
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime, vaultDir: dir });
  office.start();
  const run = store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "chat", title: "Reply in chat" });
  const caller = { agentId: CHIEF_OF_STAFF_ID, runId: run.id, profile: "conversation" as const };
  const propose = (input: object = RUT) => office.gateway.call(caller, { name: "aihub_propose_supervisor", arguments: input });
  return { store, runtime, office, propose };
}

describe("Recruitment", () => {
  it("puts the Chief of Staff's proposal in the chat as a card", async () => {
    const { store, propose } = setUp();
    const outcome = await propose();
    assert.equal(outcome.ok, true, outcome.text);
    const [proposal] = store.listProposals();
    assert.equal(proposal?.status, "pending");
    assert.equal(proposal?.payload.responsibility.expiresAt, null);
    const card = store.recentMessages(5, CHIEF_OF_STAFF_CONVERSATION_ID).find((message) => message.kind === "proposal");
    assert.equal(card?.refId, proposal?.id);
  });

  it("refuses a name in use and a proposal past the supervisor cap", async () => {
    const { store, propose } = setUp();
    const taken = await propose({ ...RUT, profile: { ...RUT.profile, name: "vera" } });
    assert.match(taken.text, /already called vera/);
    for (let n = 0; n < SUPERVISOR_LIMIT - 1; n++) {
      store.upsertAgent({ id: `s${n}`, name: `S${n}`, role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
    }
    assert.equal((await propose()).ok, true, "the last seat");
    const over = await propose({ ...RUT, profile: { ...RUT.profile, name: "Sixten" } });
    assert.equal(over.ok, false);
    assert.match(over.text, /cap of 8 supervisors, counting pending proposals/);
  });

  it("hires on approval: supervisor, responsibility, routine, and verified access, in one go", async () => {
    const { store, office, runtime, propose } = setUp();
    await propose();
    const [proposal] = store.listProposals();

    assert.throws(() => approveProposal(office, proposal!.id), InvalidRequestError);
    assert.throws(() => approveProposal(office, proposal!.id, { sourcePath: "C:/nowhere/family.ics" }), /can't read C:\/nowhere\/family\.ics/);
    assert.equal(store.getAgent("rut"), null, "nothing hired before the file reads");

    const approved = approveProposal(office, proposal!.id, { sourcePath: `"${CALENDAR}"` });
    assert.equal(approved.status, "approved");
    const rut = store.getAgent("rut")!;
    assert.deepEqual([rut.name, rut.title, rut.role, rut.managerId, rut.state], ["Rut", "Calendar Supervisor", "supervisor", CHIEF_OF_STAFF_ID, "idle"]);
    const responsibility = store.activeResponsibilityOf("rut")!;
    assert.equal(responsibility.standingInstructions, "Always flag pickups after 17:00.");
    assert.equal(store.listRoutines().find((routine) => routine.ownerId === "rut")?.trigger.type, "briefing");
    const [connection] = store.connectionsOf("rut");
    assert.deepEqual([connection?.status, connection?.path], ["connected", CALENDAR]);
    assert.match(office.notebook.read("Staff/chief-of-staff/Vera.md")!.body, /Team: \[\[Rut\]\]/);
    const notice = store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]!;
    assert.equal(notice.kind, "notice");
    assert.match(notice.body, /Rut joined as Calendar Supervisor[\s\S]*Family calendar is connected/);

    // Rut's runs start from the profile and the operator's standing instructions.
    await office.runTask({ agentId: "rut", kind: "report", title: "Check", instructions: "Check.", input: "Nothing." });
    const context = [...runtime.contexts.values()].at(-1)!;
    assert.match(context.options.instructions, /^You are Rut, Calendar Supervisor[\s\S]*Your responsibility: Family calendar\. School and activities\.\nStanding instructions from the operator: Always flag pickups after 17:00\./);

    assert.throws(() => approveProposal(office, proposal!.id, { sourcePath: CALENDAR }), ConflictError);
  });

  it("records a decline once", async () => {
    const { store, office, propose } = setUp();
    await propose();
    const [proposal] = store.listProposals();
    assert.equal(declineProposal(office, proposal!.id, "Not now").outcome, "Not now");
    assert.throws(() => declineProposal(office, proposal!.id), ConflictError);
    assert.throws(() => approveProposal(office, proposal!.id, { sourcePath: CALENDAR }), /already declined/);
  });
});
