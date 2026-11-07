import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import { Office } from "../office.ts";
import { Store } from "../store/store.ts";
import { checkProposedSource, collect, readSource, verifyConnection } from "./collect.ts";
import { FOLDER_LIMITS } from "./folder.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "aihub-folder-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const note = (title: string, status: string, extra = "") => `---\ntitle: ${title}\nstatus: ${status}\n---\n${extra}`;

function setUp(files: Record<string, string> = {}) {
  const root = tempDir();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  const store = new Store(":memory:");
  store.upsertAgent({ id: "reading", name: "Ines", role: "supervisor", managerId: null, profile: "data", charter: "" });
  const responsibility = store.createResponsibility({ ownerId: "reading", title: "Reading list", scope: "", standingInstructions: "", expiresAt: null });
  const connection = store.createConnection({ kind: "folder", label: "Reading list", path: root, pattern: "*.md", reader: "markdown" });
  return { root, store, responsibility, connection };
}

const NOW = { now: new Date("2026-11-09T06:00:00.000Z") };

describe("Folder source", () => {
  it("verifies by reading every matching file, skipping hidden folders and other files", async () => {
    const { store, connection } = setUp({
      "dune.md": note("Dune", "reading"),
      "2026/emma.md": note("Emma", "to read"),
      ".obsidian/workspace.md": note("Hidden", "x"),
      "cover.png": "not a note",
    });
    const verified = await verifyConnection(store, connection.id, NOW);
    assert.deepEqual([verified.status, verified.detail], ["connected", "2 notes in 2 files"]);
  });

  it("says what is wrong with a folder in the operator's terms", async () => {
    const { root, store } = setUp();
    const check = (path: string) => checkProposedSource({ kind: "folder", label: "Notes", reader: "markdown" }, path, NOW);
    assert.equal(await check(root), "No *.md files yet");
    await assert.rejects(check(join(root, "missing")), /The folder isn't there any more/);
    writeFileSync(join(root, "file.md"), "x");
    await assert.rejects(check(join(root, "file.md")), /That's a file, not a folder/);
    const unchosen = store.createConnection({ kind: "folder", label: "Mail", path: "", reader: "text" });
    assert.equal((await verifyConnection(store, unchosen.id, NOW)).detail, "No folder has been chosen yet.");
    const unknown = store.createConnection({ kind: "folder", label: "Odd", path: root, pattern: "*", reader: "staff:nope" });
    assert.match((await verifyConnection(store, unknown.id, NOW)).detail!, /isn't approved, so AiHub won't run it/);
  });

  it("reports files a reader can't read without losing the rest", async () => {
    const root = tempDir();
    writeFileSync(join(root, "good.json"), '[{"title": "One"}]');
    writeFileSync(join(root, "bad.json"), "{nope");
    const store = new Store(":memory:");
    const connection = store.createConnection({ kind: "folder", label: "Data", path: root, pattern: "*.json", reader: "json" });
    const verified = await verifyConnection(store, connection.id, NOW);
    assert.equal(verified.status, "connected");
    assert.match(verified.detail!, /^1 record in 2 files\. 1 file couldn't be read: bad\.json: /);
    unlinkSync(join(root, "good.json"));
    assert.match((await verifyConnection(store, connection.id, NOW)).detail!, /^None of the files could be read: bad\.json/);
  });

  it("hands over new, changed, and removed records, saying what a changed field was", async () => {
    const { root, store, responsibility, connection } = setUp({ "dune.md": note("Dune", "reading"), "emma.md": note("Emma", "to read") });
    const first = await collect(store, responsibility.id, connection, NOW);
    assert.equal(first.firstCheck, true);
    assert.match(first.firstCheckNote, /first look at this folder/);
    assert.deepEqual(
      first.records.map((record) => [record.change, record.title, record.file]).sort(),
      [
        ["new", "Dune", "dune.md"],
        ["new", "Emma", "emma.md"],
      ],
    );
    const dune = first.records.find((record) => record.title === "Dune")!;
    assert.match(dune.id, /^rec-[0-9a-f]{10}$/);
    assert.deepEqual(dune.fields, { status: "reading", text: "" });
    assert.deepEqual(first.identities.get(dune.id), { version: first.identities.get(dune.id)!.version, expiresAt: null });
    assert.equal((await collect(store, responsibility.id, connection, NOW)).records.length, 2, "not committed yet");
    first.commit();
    assert.equal((await collect(store, responsibility.id, connection, NOW)).records.length, 0);

    writeFileSync(join(root, "dune.md"), note("Dune", "finished"));
    unlinkSync(join(root, "emma.md"));
    writeFileSync(join(root, "piranesi.md"), note("Piranesi", "to read"));
    const second = await collect(store, responsibility.id, connection, NOW);
    assert.equal(second.firstCheck, false);
    const byTitle = Object.fromEntries(second.records.map((record) => [record.title, record]));
    assert.deepEqual([byTitle.Dune!.change, byTitle.Dune!.id, byTitle.Dune!.was], ["changed", dune.id, { status: "reading" }]);
    assert.deepEqual(byTitle.Emma, { id: byTitle.Emma!.id, change: "removed", title: "Emma", file: "emma.md" });
    assert.equal(byTitle.Piranesi!.change, "new");
    assert.match(second.identities.get(dune.id)!.version, /^changed:/);
    second.commit();
    assert.equal((await collect(store, responsibility.id, connection, NOW)).records.length, 0);
  });

  it("hands over a sample on the first check, and holds back the rest of a big change for later", async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 70; n++) files[`book-${String(n).padStart(2, "0")}.md`] = note(`Book ${n}`, "to read");
    const { root, store, responsibility, connection } = setUp(files);
    // The most recently changed files come first in a cut.
    utimesSync(join(root, "book-05.md"), new Date(), new Date(Date.now() + 60_000));
    const first = await collect(store, responsibility.id, connection, NOW);
    assert.equal(first.records.length, FOLDER_LIMITS.changesPerCheck);
    assert.equal(first.records[0]!.title, "Book 5");
    assert.deepEqual(first.notes, ["The folder holds 70 records; these are the 60 in the most recently changed files. AiHub records the rest as seen."]);
    first.commit();
    assert.equal((await collect(store, responsibility.id, connection, NOW)).records.length, 0, "the first check saw them all");

    for (let n = 0; n < 70; n++) writeFileSync(join(root, `book-${String(n).padStart(2, "0")}.md`), note(`Book ${n}`, "finished"));
    const second = await collect(store, responsibility.id, connection, NOW);
    assert.equal(second.records.length, 60);
    assert.deepEqual(second.notes, ["10 more changes wait for your next check."]);
    second.commit();
    const third = await collect(store, responsibility.id, connection, NOW);
    assert.equal(third.records.length, 10);
    assert.ok(third.records.every((record) => record.change === "changed"));
  });

  it("reads records for a question, filtered by words, with long text cut", async () => {
    const { store, connection } = setUp({
      "dune.md": note("Dune", "reading", "Arrakis. ".repeat(200)),
      "emma.md": note("Emma", "to read"),
    });
    const all = await readSource(connection, { days: 7, words: [], limit: 50 }, NOW);
    assert.match(all.summary, /^Reading list: 2 notes out of 2 in 2 files\. Long texts are cut at 1000 characters\.$/);
    const found = await readSource(connection, { days: 7, words: ["ARRAKIS"], limit: 50 }, NOW);
    const { records } = found.data as { records: Array<{ title: string; fields: { text: string } }> };
    assert.deepEqual(
      records.map((record) => record.title),
      ["Dune"],
    );
    assert.equal(records[0]!.fields.text.length, 1_001);
    assert.match(found.summary, /^Reading list: 1 note match "ARRAKIS" out of 2/);
    const one = await readSource(connection, { days: 7, words: [], limit: 1 }, NOW);
    assert.match(one.summary, /Showing the first 1; narrow it with words to see others\./);
    store.close();
  });
});

describe("Source isolation", () => {
  it("lets a supervisor read only the sources it holds a grant for", async () => {
    const reading = setUp({ "dune.md": note("Dune", "reading") });
    const bank = tempDir();
    writeFileSync(join(bank, "nov.csv"), "Date,Text,Amount\n2026-11-02,ICA,-412\n");
    const store = new Store(":memory:");
    const office = new Office({ store, runtime: new FakeRuntime(), vaultDir: tempDir("aihub-vault-") });
    office.start();
    for (const [id, name] of [
      ["reading", "Ines"],
      ["books", "Rut"],
    ]) {
      store.upsertAgent({ id: id!, name: name!, role: "supervisor", managerId: null, profile: "data", charter: "" });
    }
    const notes = store.createConnection({ kind: "folder", label: "Notes", path: reading.root, pattern: "*.md", reader: "markdown" });
    const ledger = store.createConnection({ kind: "folder", label: "Notes", path: bank, pattern: "*.csv", reader: "csv" });
    store.grant("reading", notes.id, ["read"]);
    store.grant("books", ledger.id, ["read"]);

    const read = async (agentId: string, source: string) => {
      const runId = store.createRun({ agentId, kind: "question", title: "Answer" }).id;
      return office.gateway.call({ agentId, runId, profile: "data" }, { name: "aihub_read_source", arguments: { source } });
    };
    // Both sources are called "Notes", and each supervisor still sees only its own.
    const ines = await read("reading", "notes");
    assert.equal(ines.ok, true, ines.text);
    assert.match(ines.text, /"title": "Dune"/);
    assert.doesNotMatch(ines.text, /ICA/);
    const rut = await read("books", "Notes");
    assert.match(rut.text, /"Text": "ICA"/);
    assert.doesNotMatch(rut.text, /Dune/);

    store.archiveAgent("books");
    const gone = await read("books", "Notes");
    assert.equal(gone.ok, false, "a revoked grant reads nothing");
    reading.store.close();
  });
});
