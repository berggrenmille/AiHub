import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DaemonEvent } from "@aihub/shared";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { RunTurnOptions, TurnResult } from "../runtime/types.ts";
import { verifyConnection } from "../sources/collect.ts";
import { Store } from "../store/store.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT, CHIEF_OF_STAFF_ID as CHIEF } from "./chief-of-staff.ts";
import { approveProposal, previewProposal } from "./proposals.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Script = (input: string, options: RunTurnOptions) => Promise<string> | string;

/** A reader for lines like "2026-11-02  ICA Maxi  -412,50". */
const BANK_READER = String.raw`function read(file) {
  return file.text.split(/\r?\n/).filter((line) => /^\d{4}-\d\d-\d\d/.test(line)).map((line) => {
    const [date, text, amount] = line.split(/\s{2,}/);
    return { key: date + " " + text + " " + amount, title: text + " " + amount, fields: { date, text, amount } };
  });
}`;

const SAMPLE = "# Export\n2026-11-02  ICA Maxi  -412,50\n2026-11-03  Salary  25 000,00\n";

const call = (options: RunTurnOptions, name: string, args: object) => options.onToolCall({ name, arguments: args });

function setUp() {
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  const office = new Office({ store, runtime, vaultDir: tempDir("aihub-toolsmith-") });
  office.start();
  const events: DaemonEvent[] = [];
  office.bus.subscribe(({ event }) => events.push(event));
  const scripts: Record<string, Script> = {};
  runtime.respond = async (input, options): Promise<TurnResult> => {
    const contextId = runtime.calls.at(-1)!.split(" ")[1]!;
    const name = /^You are (\w+)/.exec(runtime.contexts.get(contextId)!.options.instructions)![1]!;
    const script = scripts[name];
    if (!script) throw new Error(`No script for ${name}`);
    return { status: "completed", text: await script(input, options), error: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } };
  };
  const settle = async () => {
    for (let n = 0; n < 5; n++) {
      await office.queue.idle();
      await office.delegation.idle();
    }
  };
  const toolsOffered = (name: string) =>
    [...runtime.contexts.values()].filter((context) => context.options.instructions.startsWith(`You are ${name}`)).at(-1)!.options.tools.map((tool) => tool.name);
  return { store, runtime, office, events, scripts, settle, toolsOffered };
}

const COMMISSION = {
  name: "Bank export",
  format: "One transaction per line: date, text, and amount, separated by two or more spaces.",
  pattern: "*.txt",
  samples: [{ name: "sample.txt", text: SAMPLE }],
  toolsmith: "Ada",
};

describe("Readers staff write", () => {
  it("brings in a toolsmith who writes, tests, and hands in a reader, then leaves", async () => {
    const { store, office, scripts, settle, toolsOffered, events } = setUp();
    const tested: string[] = [];
    scripts.Vera = async (input, options) => {
      if (input.includes("BEGIN DELIVERABLE DATA")) return "Ada's reader is ready.";
      const outcome = await call(options, "aihub_commission_reader", COMMISSION);
      assert.equal(outcome.ok, true, outcome.text);
      return "Ada is writing it.";
    };
    scripts.Ada = async (input, options) => {
      assert.match(input, /Vera \(Chief of Staff\) hands you a task: Reader: Bank export\.[\s\S]*Sample files to test with: sample\.txt\./);
      const broken = await call(options, "aihub_test_reader", { code: "function read(file) { return file.nope.length; }" });
      tested.push(broken.text);
      const refused = await call(options, "aihub_submit_reader", { code: "function read(file) { return file.nope.length; }", notes: "Broken." });
      assert.match(refused.text, /Fix these first: sample\.txt: /);
      const good = await call(options, "aihub_test_reader", { code: BANK_READER, sample: { name: "edge.txt", text: "2026-11-05  Rent  -9 000,00" } });
      tested.push(good.text);
      const handed = await call(options, "aihub_submit_reader", { code: BANK_READER, notes: "One record per dated line." });
      assert.equal(handed.ok, true, handed.text);
      // Handed in, the code is fixed: with no reader left to write, the tools are gone.
      assert.match((await call(options, "aihub_test_reader", { code: BANK_READER })).text, /not available to this run/);
      return "Each dated line is a transaction. It skips lines without a date.";
    };

    office.chat(CHAT, "Watch my bank exports");
    await settle();

    assert.deepEqual(toolsOffered("Ada"), ["aihub_test_reader", "aihub_submit_reader", "aihub_read_source", "aihub_list_notes", "aihub_read_note", "aihub_write_note"]);
    assert.match(tested[0]!, /"error": "read\(\) threw: TypeError/);
    const result = JSON.parse(tested[1]!) as { files: Array<{ file: string; records: number; first: Array<{ title: string }> }>; errors: unknown[] };
    assert.deepEqual(
      result.files.map((file) => [file.file, file.records]),
      [
        ["sample.txt", 2],
        ["edge.txt", 1],
      ],
    );
    assert.equal(result.files[0]!.first[0]!.title, "ICA Maxi -412,50");

    const [reader] = store.listReaders();
    assert.deepEqual([reader!.name, reader!.status, reader!.authorName, reader!.notes, reader!.code], ["Bank export", "proposed", "Ada", "One record per dated line.", BANK_READER]);
    // Ada worked for Vera with no sources, handed in, and left; Vera told the operator in her chat.
    const ada = store.getAgentRecord(reader!.authorId!)!;
    assert.deepEqual([ada.role, ada.managerId, ada.status], ["worker", CHIEF, "archived"]);
    assert.ok(events.some((event) => event.type === "agent_left" && event.agentId === ada.id));
    assert.equal(store.getAssignment(reader!.assignmentId!)!.status, "accepted");
    assert.equal(store.recentMessages(1, CHAT)[0]!.body, "Ada's reader is ready.");
    assert.ok(events.some((event) => event.type === "reader" && event.reader.status === "proposed"));
  });

  it("marks a reader failed when its toolsmith never hands it in", async () => {
    const { store, office, scripts, settle } = setUp();
    scripts.Vera = async (input, options) => {
      if (!input.includes("DATA")) await call(options, "aihub_commission_reader", COMMISSION);
      return "OK.";
    };
    scripts.Ada = () => "I couldn't work it out.";
    office.chat(CHAT, "Watch my bank exports");
    await settle();
    assert.equal(store.listReaders()[0]!.status, "failed");
    assert.equal(store.getAgentRecord(store.listReaders()[0]!.authorId!)!.status, "archived");
  });

  it("runs a reader on real files only once the operator approves it, and only the code they approved", async () => {
    const { store, office, scripts, settle } = setUp();
    scripts.Vera = async (input, options) => {
      if (!input.includes("DATA")) await call(options, "aihub_commission_reader", COMMISSION);
      return "OK.";
    };
    scripts.Ada = async (_input, options) => {
      await call(options, "aihub_submit_reader", { code: BANK_READER, notes: "One record per dated line." });
      return "Done.";
    };
    office.chat(CHAT, "Watch my bank exports");
    await settle();
    const reader = store.listReaders()[0]!;

    const folder = tempDir("aihub-bank-");
    writeFileSync(join(folder, "nov.txt"), "2026-11-12  Spotify  -129,00\n2026-11-14  Rent  -9 000,00\n");
    writeFileSync(join(folder, "notes.md"), "not an export");

    // Before approval, a connection that names the reader reads nothing.
    const early = store.createConnection({ kind: "folder", label: "Early", path: folder, pattern: "*.txt", reader: `staff:${reader.id}` });
    assert.match((await verifyConnection(store, early.id, office.sourceContext())).detail!, /isn't approved, so AiHub won't run it/);

    // Vera proposes a supervisor with the reader, by name; the card previews the real folder.
    const run = store.createRun({ agentId: CHIEF, kind: "chat", title: "Hire" });
    const propose = (source: object) =>
      office.gateway.call(
        { agentId: CHIEF, runId: run.id, profile: "conversation" },
        {
          name: "aihub_propose_supervisor",
          arguments: {
            profile: { name: "Ines", title: "Bookkeeping Supervisor", description: "Watches the bank exports." },
            responsibility: { title: "Household books", scope: "Bank exports." },
            source,
            reason: "You asked.",
          },
        },
      );
    assert.match((await propose({ kind: "folder", label: "Bank", reader: "Nope" })).text, /no reader called "Nope"/);
    assert.equal((await propose({ kind: "folder", label: "Bank", reader: "bank export" })).ok, true);
    const proposal = store.listProposals()[0]!;
    assert.deepEqual(proposal.payload.source, { kind: "folder", label: "Bank", reader: `staff:${reader.id}`, pattern: "*.txt" });

    const preview = await previewProposal(office, proposal.id, folder);
    assert.equal(preview.code, BANK_READER);
    assert.match(preview.summary, /^Bank: 2 records out of 2 in 1 file\./);
    assert.deepEqual(
      (preview.data as { records: Array<{ title: string }> }).records.map((record) => record.title),
      ["Spotify -129,00", "Rent -9 000,00"],
    );
    assert.equal(store.getReader(reader.id)!.status, "proposed", "a preview approves nothing");

    await approveProposal(office, proposal.id, { sourcePath: folder });
    assert.equal(store.getReader(reader.id)!.status, "approved");
    const [connection] = store.connectionsOf("ines");
    assert.deepEqual([connection!.reader, connection!.status, connection!.detail], [`staff:${reader.id}`, "connected", "2 records in 1 file"]);

    // Approved code can't be handed in again, and code changed behind the operator's back doesn't run.
    assert.equal(store.submitReaderCode(reader.id, "function read() { return []; }", "Changed.").code, BANK_READER);
    (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE readers SET code = ? WHERE id = ?")
      .run("function read() { return [{ title: 'sneaky' }]; }", reader.id);
    const tampered = await verifyConnection(store, connection!.id, office.sourceContext());
    assert.equal(tampered.status, "failed");
    assert.match(tampered.detail!, /isn't approved, so AiHub won't run it/);
  });

  it("refuses to propose a reader that is still being written", async () => {
    const { store, office, scripts, settle } = setUp();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    scripts.Vera = async (input, options) => {
      if (!input.includes("DATA")) await call(options, "aihub_commission_reader", COMMISSION);
      return "OK.";
    };
    scripts.Ada = async () => {
      await blocked;
      return "Gave up.";
    };
    office.chat(CHAT, "Watch my bank exports");
    while (store.listReaders().length === 0 || !store.listReaders()[0]!.authorId) await new Promise((resolve) => setTimeout(resolve, 5));
    const run = store.createRun({ agentId: CHIEF, kind: "chat", title: "Hire" });
    const proposed = await office.gateway.call(
      { agentId: CHIEF, runId: run.id, profile: "conversation" },
      {
        name: "aihub_propose_supervisor",
        arguments: {
          profile: { name: "Ines", title: "Bookkeeping Supervisor", description: "Watches the bank exports." },
          responsibility: { title: "Household books", scope: "" },
          source: { kind: "folder", label: "Bank", reader: "Bank export" },
          reason: "You asked.",
        },
      },
    );
    assert.match(proposed.text, /Ada is still writing the Bank export reader/);
    const second = await office.gateway.call({ agentId: CHIEF, runId: run.id, profile: "conversation" }, { name: "aihub_commission_reader", arguments: COMMISSION });
    assert.match(second.text, /already a reader called Bank export \(drafting\)/);
    release();
    await settle();
  });
});
