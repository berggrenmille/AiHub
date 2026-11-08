import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError, InvalidRequestError } from "../errors.ts";
import { collectSections, runMorningBriefing } from "../briefing/morning.ts";
import { Office } from "../office.ts";
import { FAKE_MAIL_URL } from "../runtime/fake-connectors.ts";
import { demo, FakeRuntime } from "../runtime/fake-runtime.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "../staff/chief-of-staff.ts";
import { approveProposal } from "../staff/proposals.ts";
import { approveStaffChange } from "../staff/staff-changes.ts";
import { Store } from "../store/store.ts";
import { unsafeKey } from "./catalog.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INES = {
  profile: { name: "Ines", title: "Mail Supervisor", description: "Watches the inbox.", workingStyle: "Brief." },
  responsibility: { title: "Inbox", scope: "New mail." },
  source: {
    kind: "service",
    label: "Inbox",
    service: "Work mail",
    operation: "list_messages",
    arguments: { limit: 20, link_id: "sneaky" },
    mapping: { list: "messages", key: "id", title: "subject", time: "received_at", link: "url" },
  },
  operations: [
    { service: "Work mail", operation: "search_messages", why: "To look up earlier mail." },
    { service: "Work mail", operation: "send_message", why: "To send replies you ask for." },
  ],
  model: { id: "fake-light", effort: "low", why: "Light work." },
  reason: "You asked for someone to watch your inbox.",
};

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "aihub-services-"));
  dirs.push(dir);
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime, vaultDir: dir });
  office.start();
  const run = store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "chat", title: "Reply in chat" });
  const chief = { agentId: CHIEF_OF_STAFF_ID, runId: run.id, profile: "conversation" as const };
  const tool = (name: string, args: object, caller: { agentId: string; runId: string; profile: "conversation" | "data" } = chief) =>
    office.gateway.call(caller, { name, arguments: args });
  return { store, runtime, office, tool, mail: runtime.connectors };
}

/** Proposes the fake mail service, approves it, and signs in. */
async function connectMail(office: Office, tool: ReturnType<typeof setUp>["tool"]) {
  const proposed = await tool("aihub_propose_service", { kind: "remote_mcp", name: "Work mail", url: FAKE_MAIL_URL, reason: "To watch your inbox." });
  assert.equal(proposed.ok, true, proposed.text);
  const service = office.services.find("Work mail")!;
  await office.services.approve(service.id);
  const { url } = await office.services.signIn(service.id);
  assert.match(url, /^https:\/\/mail\.example\.test\/authorize/);
  await waitFor(() => office.store.getService(service.id)?.status === "connected");
  return office.store.getService(service.id)!;
}

/** Hires Ines through the proposal flow, ticking the given unsafe grants. */
async function hireInes(office: Office, tool: ReturnType<typeof setUp>["tool"], unsafe: string[] = []) {
  const proposed = await tool("aihub_propose_supervisor", INES);
  assert.equal(proposed.ok, true, proposed.text);
  const [proposal] = office.store.listProposals();
  await approveProposal(office, proposal!.id, { unsafe });
  const ines = office.store.getAgent("ines")!;
  const run = office.store.createRun({ agentId: ines.id, kind: "chat", title: "Reply in chat" });
  return { proposal: office.store.getProposal(proposal!.id)!, ines, caller: { agentId: ines.id, runId: run.id, profile: "data" as const } };
}

async function waitFor(check: () => boolean, ms = 2_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Services", () => {
  it("are proposed from chat as a card, approved, and signed in by the operator", async () => {
    const { store, office, tool } = setUp();
    const listed = await tool("aihub_list_services", { search: "drive" });
    assert.match(listed.text, /AiHub has no services yet/);
    assert.match(listed.text, /Fake Notes \(connector_fake_notes\)\. Linked accounts: Personal, Work\./);
    assert.match(listed.text, /Fake Drive \(connector_fake_drive\)/, "a search finds apps to connect");

    const proposed = await tool("aihub_propose_service", { kind: "remote_mcp", name: "Work mail", url: FAKE_MAIL_URL, reason: "To watch your inbox." });
    assert.equal(proposed.ok, true, proposed.text);
    const service = office.services.find("Work mail")!;
    assert.equal(service.status, "proposed");
    assert.match(service.config.kind === "remote_mcp" ? service.config.server : "", /^aihub_work_mail_[0-9a-f]{6}$/);
    const card = store.recentMessages(5, CHIEF_OF_STAFF_CONVERSATION_ID).find((message) => message.kind === "service");
    assert.equal(card?.refId, service.id);
    assert.match((await tool("aihub_propose_service", { kind: "remote_mcp", name: "work mail", url: FAKE_MAIL_URL, reason: "Again." })).text, /already called work mail/);

    const approved = await office.services.approve(service.id);
    assert.equal(approved.status, "signed_out", "it asks for a sign-in");
    await assert.rejects(() => office.services.approve(service.id), ConflictError);
    await office.services.signIn(service.id);
    await waitFor(() => store.getService(service.id)?.status === "connected");
    assert.deepEqual(
      office.services.list()[0]!.operations.map((operation) => [operation.name, operation.label, operation.openWorld]),
      [
        ["list_messages", "reads", false],
        ["search_messages", "reads", false],
        ["send_message", "changes", true],
      ],
    );
    assert.ok(store.recentMessages(10, CHIEF_OF_STAFF_CONVERSATION_ID).some((message) => message.kind === "notice" && message.body.startsWith("Signed in to Work mail.")));
    const described = await tool("aihub_list_services", { service: "Work mail" });
    assert.match(described.text, /send_message \(changes things\)/);
    assert.match(described.text, /Input: to \(string, required\)/);
  });

  it("needs the operator's own tick for a program that runs on this PC", async () => {
    const { office, tool } = setUp();
    await tool("aihub_propose_service", { kind: "local_mcp", name: "Local files", command: "node", args: ["server.mjs"], reason: "To read notes." });
    const service = office.services.find("Local files")!;
    assert.deepEqual([service.unsafe?.key, service.unsafe?.required], [unsafeKey.service(service.id), true]);
    await assert.rejects(() => office.services.approve(service.id), InvalidRequestError);
    assert.equal(office.store.getService(service.id)?.status, "proposed");
    const approved = await office.services.approve(service.id, [unsafeKey.service(service.id)]);
    assert.equal(approved.status, "connected", "a program with no sign-in is reachable at once");
  });

  it("pins an app's account: one with several needs it named, and the daemon sets link_id on every call", async () => {
    const { office, tool, mail } = setUp();
    assert.match((await tool("aihub_propose_service", { kind: "app", app: "Fake Notes", reason: "Notes." })).text, /several accounts: Personal, Work/);
    assert.equal((await tool("aihub_propose_service", { kind: "app", app: "fake notes", account: "work", reason: "Notes." })).ok, true);
    const service = office.services.find("Fake Notes (Work)")!;
    assert.equal(service.config.kind === "app" && service.config.linkId, "link-work");
    await office.services.approve(service.id);
    const result = await office.services.call(service.id, "fake_notes.list_notes", { link_id: "link-personal" });
    assert.equal(result.ok, true);
    assert.equal(mail.calls.at(-1)?.args.link_id, "link-work", "whatever the caller says, the pinned account is read");

    const proposedDrive = await tool("aihub_propose_service", { kind: "app", app: "Fake Drive", reason: "Files." });
    assert.equal(proposedDrive.ok, true);
    const drive = await office.services.approve(office.services.find("Fake Drive")!.id);
    assert.equal(drive.status, "signed_out");
    assert.match(drive.detail ?? "", /Connect Fake Drive at ChatGPT/);
    assert.equal(drive.connectUrl, "https://chatgpt.com/apps/fake-drive");
  });

  it("marks what breaks the data boundary on a hiring card, and grants an unticked optional one never", async () => {
    const { store, office, tool } = setUp();
    const service = await connectMail(office, tool);
    const { proposal, ines, caller } = await hireInes(office, tool);
    assert.deepEqual(
      proposal.payload.unsafe?.map((grant) => [grant.key, grant.required]),
      [[unsafeKey.operation(service.id, "send_message"), false]],
      "only sending is unsafe: the inbox and search only read",
    );
    assert.deepEqual(proposal.payload.source?.service?.arguments, { limit: 20 }, "staff never pick the account");
    assert.deepEqual(
      store.listServiceGrants(ines.id).map((grant) => grant.operation),
      ["search_messages"],
    );
    assert.match(store.recentMessages(5, CHIEF_OF_STAFF_CONVERSATION_ID).at(-1)!.body, /Left out, as you didn't tick it: send_message on Work mail\./);

    const refused = await tool("aihub_use_service", { service: "Work mail", operation: "send_message", arguments: { to: "anyone@example.test", subject: "Hi", body: "Hello" } }, caller);
    assert.equal(refused.ok, false);
    assert.match(refused.text, /You may not call send_message on Work mail\. Yours: search_messages on Work mail/);
  });

  it("lets a supervisor call a ticked unsafe operation, logged and marked, until the operator takes it back", async () => {
    const { store, office, tool, mail } = setUp();
    const service = await connectMail(office, tool);
    const { ines, caller } = await hireInes(office, tool, [unsafeKey.operation(service.id, "send_message")]);
    const send = store.listServiceGrants(ines.id).find((grant) => grant.operation === "send_message")!;
    assert.match(send.unsafe ?? "", /send what they know to anyone/);

    const sent = await tool("aihub_use_service", { service: "work mail", operation: "send_message", arguments: { to: "anna@example.test", subject: "Re: Dinner", body: "Yes!" } }, caller);
    assert.equal(sent.ok, true, sent.text);
    assert.match(sent.text, /BEGIN SOURCE DATA\n[\s\S]*"sent": true[\s\S]*\nEND SOURCE DATA/);
    assert.deepEqual(mail.sent, [{ to: "anna@example.test", subject: "Re: Dinner", body: "Yes!" }]);
    assert.ok(store.recentActivity(10).some((entry) => entry.kind === "service" && entry.summary === "Unsafe: Ines called send_message on Work mail"));
    assert.notEqual(store.serviceGrantFor(ines.id, service.id, "send_message")?.lastUsedAt, null);

    office.services.revokeGrant(send.id);
    const again = await tool("aihub_use_service", { service: "Work mail", operation: "send_message", arguments: { to: "anna@example.test", subject: "Again", body: "Hi" } }, caller);
    assert.equal(again.ok, false);
    assert.equal(mail.sent.length, 1);
  });

  it("adds an operation later with a staff change, where the unsafe one needs its own tick too", async () => {
    const { store, office, tool, mail } = setUp();
    const service = await connectMail(office, tool);
    const { ines, caller } = await hireInes(office, tool);
    const change = (operations: object[]) => tool("aihub_propose_staff_change", { supervisor: "Ines", change: "operations", operations, reason: "You asked for it." });
    assert.match((await change([{ service: "Work mail", operation: "search_messages", why: "Again." }])).text, /Ines may already call search_messages on Work mail\./);
    assert.match((await change([{ service: "Work mail", operation: "delete_everything", why: "No." }])).text, /Work mail has no operation called delete_everything/);
    assert.match((await tool("aihub_propose_staff_change", { supervisor: "Ines", change: "end", operations: [{ service: "Work mail", operation: "send_message", why: "x" }], reason: "x" })).text, /An end change takes no operations\./);

    const review = { agentId: CHIEF_OF_STAFF_ID, runId: store.createRun({ agentId: CHIEF_OF_STAFF_ID, kind: "review", title: "Staff review" }).id, profile: "conversation" as const };
    const fromReview = await tool("aihub_propose_staff_change", { supervisor: "Ines", change: "operations", operations: [{ service: "Work mail", operation: "send_message", why: "x" }], reason: "x" }, review);
    assert.match(fromReview.text, /A staff review doesn't add operations/);

    const proposed = await change([{ service: "Work mail", operation: "send_message", why: "To send replies you ask for." }]);
    assert.equal(proposed.ok, true, proposed.text);
    const [pending] = store.pendingStaffChanges(ines.id);
    assert.equal(pending?.change.kind, "operations");
    assert.deepEqual(pending?.change.kind === "operations" && pending.change.unsafe.map((grant) => grant.key), [unsafeKey.operation(service.id, "send_message")]);

    await assert.rejects(() => approveStaffChange(office, pending!.id), /none is ticked/);
    assert.equal(store.getStaffChange(pending!.id)?.status, "pending", "nothing was decided");
    const approved = await approveStaffChange(office, pending!.id, [unsafeKey.operation(service.id, "send_message")]);
    assert.match(approved.outcome ?? "", /Ines may call send_message on Work mail \(unsafe, as you ticked\) from the next run\./);
    assert.ok(store.recentActivity(10).some((entry) => entry.summary === "Unsafe: the operator let Ines call send_message on Work mail"));
    const sent = await tool("aihub_use_service", { service: "Work mail", operation: "send_message", arguments: { to: "anna@example.test", subject: "Hi", body: "Hello" } }, caller);
    assert.equal(sent.ok, true, sent.text);
    assert.equal(mail.sent.length, 1);
  });

  it("reads the inbox at the briefing in code, keyed and linked, and only what is new after that", async () => {
    const { store, runtime, office, tool, mail } = setUp();
    runtime.respond = demo;
    await connectMail(office, tool);
    const { ines } = await hireInes(office, tool);
    const connection = store.connectionsOf(ines.id)[0]!;
    assert.deepEqual([connection.kind, connection.status, connection.detail], ["service", "connected", "4 records in the latest read"]);

    const [first] = await collectSections(office);
    assert.equal(first?.firstCheck, true);
    assert.equal(first?.changes.length, 4);
    assert.deepEqual(Object.keys(first!.changes[0] as object).sort(), ["change", "fields", "id", "link", "time", "title"]);
    assert.equal((first!.changes[0] as { title: string }).title, "Parent meeting moved to Thursday", "newest first");

    await runMorningBriefing(office);
    const items = store.listItems();
    assert.ok(items.length > 0, "the fake supervisor reported the new mail");
    assert.ok(items.every((item) => item.link?.startsWith("https://mail.example.test/m/")), "each item opens its message");

    assert.equal((await collectSections(office))[0]?.changes.length, 0, "nothing new, nothing handed over");
    mail.deliver({ from: "anna@example.test", subject: "Changed my mind about Friday", received_at: "2026-11-08T08:00:00.000Z", snippet: "Saturday instead?" });
    const [later] = await collectSections(office);
    assert.deepEqual(later?.changes.map((change) => (change as { title: string }).title), ["Changed my mind about Friday"]);
  });

  it("says a lapsed sign-in at the health check and in the source, and removing a service takes everything on it away", async () => {
    const { store, office, tool, mail } = setUp();
    const service = await connectMail(office, tool);
    const { ines, caller } = await hireInes(office, tool);
    mail.mailSignedIn = false;
    const search = () => tool("aihub_use_service", { service: "Work mail", operation: "search_messages", arguments: { query: "dinner" } }, caller);
    assert.match((await search()).text, /^Work mail answered with an error\. Everything between the markers/);
    assert.equal(store.getService(service.id)?.status, "signed_out", "a call that finds the sign-in gone marks it");
    assert.equal(store.getService(service.id)?.detail, "The sign-in has lapsed: 401 Unauthorized: not logged in. Sign in again.");
    await search();
    const signedOut = store.recentMessages(20, CHIEF_OF_STAFF_CONVERSATION_ID).filter((message) => message.body.startsWith("Work mail is signed out"));
    assert.equal(signedOut.length, 1, "said once");
    const lapsed = await office.services.checkAll();
    assert.deepEqual(lapsed.map((record) => [record.name, record.status]), [["Work mail", "signed_out"]]);
    const read = await tool("aihub_read_source", { source: "Inbox" }, caller);
    assert.equal(read.ok, false);
    assert.match(read.text, /Work mail is signed out/);

    mail.mailSignedIn = true;
    await office.services.refresh(service.id);
    assert.equal(store.getService(service.id)?.status, "connected");
    office.services.remove(service.id);
    assert.equal(store.getService(service.id)?.status, "removed");
    assert.deepEqual(store.listServiceGrants(ines.id), []);
    assert.deepEqual(store.connectionsOf(ines.id), [], "the inbox source went with it");
    assert.ok(store.abandonedConnectionIds().size === 1, "the health check skips a source nobody reads");
    assert.throws(() => office.services.remove(service.id), ConflictError);
  });

  it("gives live web search only with its tick, and never passes it or an unsafe grant on", async () => {
    const { store, office, tool } = setUp();
    const service = await connectMail(office, tool);
    await tool("aihub_propose_supervisor", { ...INES, web: { sites: [], live: true } });
    const [proposal] = store.listProposals();
    assert.deepEqual(proposal?.payload.unsafe?.map((grant) => grant.key), [unsafeKey.operation(service.id, "send_message"), unsafeKey.liveWeb]);
    await approveProposal(office, proposal!.id, { unsafe: [unsafeKey.liveWeb, unsafeKey.operation(service.id, "send_message")] });
    assert.deepEqual(store.webGrantOf("ines"), { sites: [], live: true });

    store.upsertAgent({ id: "nils", name: "Nils", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
    store.handOver("ines", "nils", store.activeResponsibilityOf("ines")!.id);
    assert.deepEqual(store.webGrantOf("nils"), { sites: [] }, "live search becomes cached");
    assert.deepEqual(store.listServiceGrants("nils").map((grant) => grant.operation), ["search_messages"], "the unsafe send stays behind");
  });
});
