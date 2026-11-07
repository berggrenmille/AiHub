import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRecords, ReaderOutputError } from "./reader.ts";
import { parseCsv, readCsv, readJson, readMarkdown, readText } from "./readers.ts";

describe("Built-in readers", () => {
  it("reads a markdown note: frontmatter as fields, title from frontmatter, a heading, or the file", () => {
    const [book] = readMarkdown({
      name: "2026/dune.md",
      text: "---\ntitle: Dune\nauthor: \"Frank Herbert\"\nrating: 4\nfinished: false\ntags: [scifi, classic]\nshelves:\n  - home\n  - loaned\n---\n# Notes\nStarted on the train.\n",
    });
    assert.deepEqual(book, {
      key: "",
      title: "Dune",
      fields: { author: "Frank Herbert", rating: 4, finished: false, tags: "scifi, classic", shelves: "home, loaned", text: "# Notes\nStarted on the train." },
    });
    assert.equal(readMarkdown({ name: "a.md", text: "Intro\n\n# Project Hail Mary\nGood." })[0]!.title, "Project Hail Mary");
    assert.equal(readMarkdown({ name: "lists/To read.md", text: "- Piranesi" })[0]!.title, "To read");
  });

  it("reads a text file with its first line as the title", () => {
    assert.deepEqual(readText({ name: "memo.txt", text: "\r\nCall the bank\r\nAbout the mortgage.\r\n" }), [
      { key: "", title: "Call the bank", fields: { text: "Call the bank\nAbout the mortgage." } },
    ]);
  });

  it("reads CSV with semicolons, quotes, a BOM, and line breaks inside fields", () => {
    const text = '﻿Datum;Text;Belopp;Text\n2026-11-02;"ICA; Maxi";-412,50;"two\nlines"\n\n2026-11-03;"Say ""hi""";1 200,00;\n';
    const rows = readCsv({ name: "bank.csv", text });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]!.fields, { Datum: "2026-11-02", Text: "ICA; Maxi", Belopp: "-412,50", "Text 2": "two\nlines" });
    assert.equal(rows[0]!.title, "2026-11-02 · ICA; Maxi · -412,50");
    assert.equal(rows[1]!.fields.Text, 'Say "hi"');
    assert.match(rows[0]!.key, /^[0-9a-f]{12}$/, "keyed by content without an id column");
    assert.notEqual(rows[0]!.key, rows[1]!.key);
  });

  it("keys CSV rows by an id column when there is one", () => {
    const rows = readCsv({ name: "books.csv", text: "ID,Title,Status\n7,Dune,reading\n9,Emma,\n" });
    assert.deepEqual(
      rows.map((row) => [row.key, row.title]),
      [
        ["7", "7 · Dune · reading"],
        ["9", "9 · Emma"],
      ],
    );
    assert.deepEqual(parseCsv("a,b\r\n1,2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads JSON lists, an object holding one list, or a single object", () => {
    const list = readJson({ name: "a.json", text: '[{"id": 3, "name": "Dune", "meta": {"pages": 412}}, "loose"]' });
    assert.deepEqual(list[0], { key: "3", title: "Dune", fields: { id: 3, name: "Dune", meta: '{"pages":412}' } });
    assert.equal(list[1]!.title, '"loose"');
    assert.deepEqual(
      readJson({ name: "b.json", text: '{"version": 2, "items": [{"title": "One"}, {"title": "Two"}]}' }).map((record) => record.title),
      ["One", "Two"],
    );
    assert.equal(readJson({ name: "c.json", text: '{"subject": "Renewal", "due": "2026-12-01"}' })[0]!.title, "Renewal");
    assert.throws(() => readJson({ name: "d.json", text: "{nope" }), SyntaxError);
  });
});

describe("Reader output check", () => {
  it("clips long text and turns a numeric key into text", () => {
    const [record] = checkRecords([{ key: 12, title: "x".repeat(300), fields: { body: "y".repeat(3_000), score: 4.5, done: true } }]);
    assert.equal(record!.key, "12");
    assert.equal(record!.title.length, 200);
    assert.equal(String(record!.fields.body).length, 2_000);
    assert.equal(record!.fields.score, 4.5);
    assert.equal(record!.fields.done, true);
  });

  it("refuses output that isn't a list of records, saying what is wrong", () => {
    assert.throws(() => checkRecords({ title: "one" }), /a list of records, not an object/);
    assert.throws(() => checkRecords([{ fields: {} }]), ReaderOutputError);
    assert.throws(() => checkRecords([{ title: "x", fields: { nested: { a: 1 } } }]), /Record 1 isn't/);
    assert.throws(() => checkRecords(Array.from({ length: 5_001 }, () => ({ title: "x" }))), /at most 5000 records/);
  });
});
