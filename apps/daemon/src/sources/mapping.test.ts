import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MappingProblem, mapRecords, outputOf, valueAt } from "./mapping.ts";

const output = {
  data: {
    items: [
      { id: 7, subject: "Dinner on Friday?", received: "2026-11-06T17:42:00Z", url: "https://mail.example.test/m/7", from: "anna@example.test", labels: ["inbox"] },
      { id: 8, subject: "  ", url: "javascript:alert(1)", body: "x".repeat(2_000) },
      { id: 7, subject: "A second copy" },
      { subject: "No id" },
      "not a record",
    ],
  },
};

describe("Mapping a service's output", () => {
  it("finds the list at a dotted path and keys, titles, times, and links each record", () => {
    assert.equal(valueAt(output, "data.items.length"), 5);
    assert.equal(valueAt(output, ""), output);
    assert.equal(valueAt(output, "data.nothing.here"), undefined);
    const records = mapRecords(output, { list: "data.items", key: "id", title: "subject", time: "received", link: "url" });
    assert.deepEqual(
      records.map((record) => [record.key, record.title, record.time, record.link]),
      [
        ["7", "Dinner on Friday?", "2026-11-06T17:42:00Z", "https://mail.example.test/m/7"],
        ["8", "(untitled)", null, null],
      ],
      "only web addresses, no duplicates, and nothing without a key",
    );
    assert.deepEqual(records[0]!.fields, { from: "anna@example.test", labels: '["inbox"]' }, "the mapped fields aren't repeated");
    assert.equal((records[1]!.fields.body as string).length, 1_001, "long values are cut");
  });

  it("fingerprints a record without a version field, so a change shows", () => {
    const mapping = { list: "", key: "id", title: "name" };
    const [before] = mapRecords([{ id: "a", name: "Groceries", items: 3 }], mapping);
    const [after] = mapRecords([{ id: "a", name: "Groceries", items: 4 }], mapping);
    assert.notEqual(before!.version, after!.version);
    const [versioned] = mapRecords([{ id: "a", name: "Groceries", etag: "v9" }], { ...mapping, version: "etag" });
    assert.equal(versioned!.version, "v9");
  });

  it("says what the output looks like when the mapping doesn't fit it", () => {
    assert.throws(() => mapRecords(output, { list: "items", key: "id", title: "subject" }), (error: Error) => error instanceof MappingProblem && /no list at "items"\. Its fields: data\./.test(error.message));
    assert.throws(() => mapRecords(output, { list: "data.items", key: "uid", title: "subject" }), /None of the 5 entries has a "uid".*Its fields: id, subject/);
    assert.deepEqual(mapRecords({ messages: [] }, { list: "messages", key: "id", title: "subject" }), [], "an empty inbox is fine");
  });

  it("reads structured output, or text that is JSON, and refuses plain text", () => {
    assert.deepEqual(outputOf({ text: "ignored", structured: { a: 1 } }), { a: 1 });
    assert.deepEqual(outputOf({ text: '{"a":2}', structured: null }), { a: 2 });
    assert.throws(() => outputOf({ text: "Here are your messages.", structured: null }), MappingProblem);
  });
});
