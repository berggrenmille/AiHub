import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProposedSource, SourcePreview, StaffReader } from "@aihub/shared";
import { approvalGate, describeSource, patternOf, previewRows, readerName, readerOf, showValue, staffReaderId, type PreviewState } from "./sources.ts";

function staffReader(overrides: Partial<StaffReader> = {}): StaffReader {
  return {
    id: "r1",
    name: "Bank export",
    format: "One transaction per line.",
    pattern: "*.txt",
    sampleNames: ["sample.txt"],
    status: "proposed",
    code: "function read(file) { return []; }",
    notes: "One record per line.",
    authorId: "ada",
    authorName: "Ada",
    requesterId: "chief-of-staff",
    assignmentId: "asg-1",
    approvedAt: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

const bank: ProposedSource = { kind: "folder", label: "Bank export", reader: "staff:r1", pattern: "*.txt" };
const reading: ProposedSource = { kind: "folder", label: "Reading list", reader: "markdown" };
const calendar: ProposedSource = { kind: "ics_file", label: "Work calendar" };
const preview: SourcePreview = { summary: "3 records", data: { records: [] }, code: null };

describe("readers", () => {
  it("tells a staff reader from a built-in one", () => {
    assert.equal(staffReaderId("staff:r1"), "r1");
    assert.equal(staffReaderId("markdown"), null);
    assert.equal(staffReaderId("staff:"), null);
    assert.equal(staffReaderId(null), null);
  });

  it("looks up the reader a source names", () => {
    const readers = [staffReader()];
    assert.deepEqual(readerOf("csv", readers), { kind: "built_in", name: "csv", label: "CSV", files: "CSV files", pattern: "*.csv" });
    assert.equal(readerOf("staff:r1", readers)?.kind, "staff");
    assert.equal(readerName(readerOf("staff:r1", readers)), "Bank export");
    assert.deepEqual(readerOf("staff:gone", readers), { kind: "staff", id: "gone", reader: null });
    assert.deepEqual(readerOf("yaml", readers), { kind: "unknown", name: "yaml" });
    assert.equal(readerOf(undefined, readers), null);
    assert.equal(readerName(readerOf("markdown", readers)), "Markdown (built in)");
  });

  it("falls back to the reader's own pattern when the source names none", () => {
    const readers = [staffReader({ pattern: "*.dat" })];
    assert.equal(patternOf(reading, readers), "*.md");
    assert.equal(patternOf({ ...reading, pattern: " *.markdown " }, readers), "*.markdown");
    assert.equal(patternOf({ reader: "staff:r1" }, readers), "*.dat");
    assert.equal(patternOf({ reader: "staff:gone" }, readers), "*");
  });

  it("describes a source plainly", () => {
    const readers = [staffReader()];
    assert.equal(describeSource(reading, readers).kind, "folder of markdown notes, *.md");
    assert.equal(describeSource(bank, readers).kind, "folder of *.txt files, read by the Bank export reader");
    assert.equal(describeSource({ ...bank, reader: "staff:gone" }, readers).kind, "folder of *.txt files, read by a reader staff wrote");
    assert.equal(describeSource(calendar, readers).kind, "calendar file");
    assert.match(describeSource(calendar, readers).pick, /\.ics/);
  });
});

describe("approving a source", () => {
  const idle: PreviewState = { status: "idle" };
  const done = (path: string): PreviewState => ({ status: "done", path, preview });

  it("lets a built-in reader or a calendar through without a preview", () => {
    assert.deepEqual(approvalGate(reading, [], "", idle), { ready: true, reason: null, tone: "info" });
    assert.equal(approvalGate(calendar, [], "C:/cal.ics", idle).ready, true);
    assert.equal(approvalGate(null, [], "", idle).ready, true);
  });

  it("waits for a preview of the path being approved", () => {
    const readers = [staffReader()];
    const before = approvalGate(bank, readers, "C:/bank", idle);
    assert.equal(before.ready, false);
    assert.match(before.reason ?? "", /Preview the folder first/);
    assert.match(before.reason ?? "", /Ada wrote/);

    assert.equal(approvalGate(bank, readers, "C:/bank", { status: "loading", path: "C:/bank" }).ready, false);
    const after = approvalGate(bank, readers, " C:/bank ", done("C:/bank"));
    assert.equal(after.ready, true);
    assert.equal(after.tone, "done");
    assert.match(after.reason ?? "", /also approves the Bank export reader/);

    // A preview of another path doesn't count.
    assert.equal(approvalGate(bank, readers, "C:/other", done("C:/bank")).ready, false);
    assert.equal(approvalGate(bank, readers, "", done("")).ready, false);
  });

  it("says when the preview couldn't read the folder", () => {
    const gate = approvalGate(bank, [staffReader()], "C:/nope", { status: "failed", path: "C:/nope", error: "Not there" });
    assert.equal(gate.ready, false);
    assert.match(gate.reason ?? "", /couldn't read/);
  });

  it("still wants a preview for a reader approved before, without saying it approves it again", () => {
    const readers = [staffReader({ status: "approved" })];
    assert.equal(approvalGate(bank, readers, "C:/bank", idle).ready, false);
    assert.deepEqual(approvalGate(bank, readers, "C:/bank", done("C:/bank")), { ready: true, reason: null, tone: "done" });
  });

  it("blocks a reader that isn't ready, whatever the preview", () => {
    for (const readers of [[staffReader({ status: "failed" })], [staffReader({ status: "drafting" })], []]) {
      const gate = approvalGate(bank, readers, "C:/bank", done("C:/bank"));
      assert.equal(gate.ready, false);
      assert.equal(gate.tone, "blocked");
      assert.match(gate.reason ?? "", /isn't ready/);
    }
    assert.match(approvalGate(bank, [staffReader({ status: "failed" })], "", idle).reason ?? "", /never finished/);
    assert.match(approvalGate(bank, [staffReader({ status: "drafting" })], "", idle).reason ?? "", /Ada is still writing/);
  });
});

describe("preview rows", () => {
  it("shows a folder's records with their file and first fields", () => {
    const rows = previewRows({
      records: [
        { id: "rec-1", title: "Piranesi", file: "piranesi.md", fields: { status: "reading", author: "Susanna Clarke", text: "x".repeat(200), rating: 5 } },
        { id: "rec-2", title: "", file: "", fields: null },
      ],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]!.fields.map(([name]) => name), ["status", "author", "text"]);
    assert.equal(rows[0]!.detail, "piranesi.md");
    assert.ok(rows[0]!.fields[2]![1].endsWith("…"));
    assert.ok(rows[0]!.fields[2]![1].length <= 80);
    assert.deepEqual(rows[1], { key: "rec-2", title: "(untitled)", detail: null, fields: [] });
  });

  it("shows a calendar's events with their time", () => {
    const rows = previewRows({
      series: [{ id: "s-1", title: "Standup", repeats: "FREQ=DAILY", since: "Mon 2 Nov 09:00" }],
      events: [{ id: "evt-1", title: "Standup", when: "Mon 9 Nov 09:00–09:15", location: "Room 4", series: "s-1" }],
    });
    assert.deepEqual(rows, [{ key: "evt-1", title: "Standup", detail: "Mon 9 Nov 09:00–09:15", fields: [["location", "Room 4"]] }]);
  });

  it("gives no rows for data it doesn't know", () => {
    assert.deepEqual(previewRows(null), []);
    assert.deepEqual(previewRows("records"), []);
    assert.deepEqual(previewRows({ something: [] }), []);
    assert.deepEqual(previewRows({ records: [1, "two", null] }), []);
  });

  it("puts any value on one short line", () => {
    assert.equal(showValue(null), "—");
    assert.equal(showValue("  "), "—");
    assert.equal(showValue(-412.5), "-412.5");
    assert.equal(showValue(true), "true");
    assert.equal(showValue("two\nlines"), "two lines");
    assert.equal(showValue({ a: 1 }), '{"a":1}');
  });
});
