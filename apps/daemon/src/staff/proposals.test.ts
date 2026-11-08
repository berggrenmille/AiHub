import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  model: { id: "fake-light", effort: "low", why: "Reading one calendar is light work." },
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
    assert.match((await propose({ ...RUT, profile: { ...RUT.profile, name: "rut" } })).text, /A proposal waiting for the operator is already called rut/);
    const over = await propose({ ...RUT, profile: { ...RUT.profile, name: "Sixten" } });
    assert.equal(over.ok, false);
    assert.match(over.text, new RegExp(`cap of ${SUPERVISOR_LIMIT} supervisors, counting pending proposals`));
  });

  it("hires on approval: supervisor, responsibility, routine, and verified access, in one go", async () => {
    const { store, office, runtime, propose } = setUp();
    await propose();
    const [proposal] = store.listProposals();

    await assert.rejects(() => approveProposal(office, proposal!.id), InvalidRequestError);
    await assert.rejects(() => approveProposal(office, proposal!.id, { sourcePath: "C:/nowhere/family.ics" }), /can't read C:\/nowhere\/family\.ics/);
    assert.equal(store.getAgent("rut"), null, "nothing hired before the file reads");

    const approved = await approveProposal(office, proposal!.id, { sourcePath: `"${CALENDAR}"` });
    assert.equal(approved.status, "approved");
    const rut = store.getAgent("rut")!;
    assert.deepEqual([rut.name, rut.title, rut.role, rut.managerId, rut.state], ["Rut", "Calendar Supervisor", "supervisor", CHIEF_OF_STAFF_ID, "idle"]);
    const responsibility = store.activeResponsibilityOf("rut")!;
    assert.equal(responsibility.standingInstructions, "Always flag pickups after 17:00.");
    assert.equal(store.listRoutines().find((routine) => routine.ownerId === "rut")?.trigger.type, "briefing");
    const [connection] = store.connectionsOf("rut");
    assert.deepEqual([connection?.status, connection?.path], ["connected", CALENDAR]);
    assert.deepEqual(store.getAgent("rut")!.connectionIds, [connection!.id]);
    assert.equal(rut.avatar, "Rut", "the look the card showed");
    assert.match(office.notebook.read("Staff/chief-of-staff/Vera.md")!.body, /Team: \[\[Rut\]\]/);
    const notice = store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]!;
    assert.equal(notice.kind, "notice");
    assert.match(notice.body, /Rut joined as Calendar Supervisor[\s\S]*Family calendar is connected[\s\S]*Rut runs on Fake Light, low reasoning\./);
    assert.deepEqual([rut.model, rut.effort], ["fake-light", "low"], "what Vera picked");

    // Rut's runs start from the profile and the operator's standing instructions, on Rut's model.
    const checked = await office.runTask({ agentId: "rut", kind: "report", title: "Check", instructions: "Check.", input: "Nothing." });
    assert.deepEqual([checked.run.model, checked.run.effort], ["fake-light", "low"]);
    const context = [...runtime.contexts.values()].at(-1)!;
    assert.match(context.options.instructions, /^You are Rut, Calendar Supervisor[\s\S]*Your responsibility: Family calendar\. School and activities\.\nStanding instructions from the operator: Always flag pickups after 17:00\.\nYour sources, by the names aihub_read_source takes: Family calendar\./);

    await assert.rejects(() => approveProposal(office, proposal!.id, { sourcePath: CALENDAR }), ConflictError);
  });

  it("has Vera pick a model and reasoning level Codex offers", async () => {
    const { store, office, propose } = setUp();
    const caller = { agentId: CHIEF_OF_STAFF_ID, runId: store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "chat", title: "Hire" }).id, profile: "conversation" as const };
    const listed = await office.gateway.call(caller, { name: "aihub_list_models", arguments: {} });
    assert.match(listed.text, /- fake-standard \(Fake Standard, the office default\): The everyday model\. Reasoning: low \(its default\), medium, high\./);
    assert.match(listed.text, /- fake-light \(Fake Light\): .* Reasoning: low, medium \(its default\)\./);

    assert.match((await propose({ ...RUT, model: { ...RUT.model, id: "gpt-9" } })).text, /There is no model "gpt-9"\. The models: fake-standard, fake-light\. See aihub_list_models\./);
    assert.match((await propose({ ...RUT, model: { ...RUT.model, effort: "high" } })).text, /Fake Light has no "high" reasoning\. It has: low, medium\./);
    const { model: _model, ...unpicked } = RUT;
    assert.equal((await propose(unpicked)).ok, false, "a supervisor needs a model picked");
    assert.equal(store.listProposals().length, 0);

    assert.equal((await propose()).ok, true);
    assert.deepEqual(store.listProposals()[0]?.payload.model, RUT.model);
  });

  it("hires for a folder of notes, reading the folder before anyone joins", async () => {
    const { store, office, propose } = setUp();
    const folder = mkdtempSync(join(tmpdir(), "aihub-reading-"));
    dirs.push(folder);
    writeFileSync(join(folder, "Dune.md"), "---\nstatus: reading\n---\n");
    const ines = {
      ...RUT,
      profile: { ...RUT.profile, name: "Ines", title: "Reading List Supervisor" },
      responsibility: { title: "Reading list", scope: "Books to read and notes on them.", standingInstructions: "" },
      source: { kind: "folder", label: "Reading list", reader: "markdown" },
    };
    assert.match((await propose({ ...ines, source: { kind: "folder", label: "Reading list" } })).text, /needs a reader/);
    assert.match((await propose({ ...ines, source: { ...RUT.source, reader: "csv" } })).text, /takes no reader/);
    assert.equal((await propose(ines)).ok, true);
    const [proposal] = store.listProposals();

    await assert.rejects(() => approveProposal(office, proposal!.id), /Pick the folder for Reading list/);
    await assert.rejects(() => approveProposal(office, proposal!.id, { sourcePath: join(folder, "Dune.md") }), /That's a file, not a folder/);
    assert.equal(store.getAgent("ines"), null);

    await approveProposal(office, proposal!.id, { sourcePath: folder });
    const [connection] = store.connectionsOf("ines");
    assert.deepEqual(
      [connection?.kind, connection?.reader, connection?.pattern, connection?.status, connection?.detail],
      ["folder", "markdown", "*.md", "connected", "1 note in 1 file"],
    );
  });

  it("hires a researcher with web search and no source, and needs one or the other", async () => {
    const { store, office, runtime, propose } = setUp();
    const nora = {
      profile: { name: "Nora", title: "News Supervisor", description: "Briefs the operator on world news.", workingStyle: "" },
      responsibility: { title: "World news", scope: "Politics and economics.", standingInstructions: "" },
      source: null,
      model: { id: "fake-standard", effort: "medium", why: "Weighing the news takes some judgment." },
      reason: "You asked for a daily news summary.",
    };
    assert.match((await propose(nora)).text, /needs something to check: a source on this PC, or web search/);
    assert.match((await propose({ ...nora, web: { sites: ["a site"] } })).text, /isn't a site/);
    const outcome = await propose({ ...nora, web: { sites: ["https://www.Reuters.com/world"] } });
    assert.equal(outcome.ok, true, outcome.text);
    const [proposal] = store.listProposals();
    assert.deepEqual(proposal?.payload.web, { sites: ["www.reuters.com"] });

    await approveProposal(office, proposal!.id);
    assert.deepEqual(store.getAgent("nora")?.web, { sites: ["www.reuters.com"] });
    assert.deepEqual([store.getAgent("nora")?.model, store.getAgent("nora")?.effort], ["fake-standard", "medium"]);
    assert.deepEqual(store.connectionsOf("nora"), []);
    assert.match(store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID)[0]!.body, /Nora joined as News Supervisor and reports in the next morning briefing\. Nora has web search on www\.reuters\.com\./);
    await office.runTask({ agentId: "nora", kind: "report", title: "Check", instructions: "Check.", input: "Nothing." });
    assert.deepEqual([...runtime.contexts.values()].at(-1)!.options.web, { mode: "cached", sites: ["www.reuters.com"] });
  });

  it("records a decline once", async () => {
    const { store, office, propose } = setUp();
    await propose();
    const [proposal] = store.listProposals();
    assert.equal(declineProposal(office, proposal!.id, "Not now").outcome, "Not now");
    assert.throws(() => declineProposal(office, proposal!.id), ConflictError);
    await assert.rejects(() => approveProposal(office, proposal!.id, { sourcePath: CALENDAR }), /already declined/);
  });
});
