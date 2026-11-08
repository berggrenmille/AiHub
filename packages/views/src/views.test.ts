import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkView, DASHBOARD_EXAMPLE, formatTime, REPLY_EXAMPLE, viewGuide, VIEW_PROGRAM_LIMIT } from "./index.ts";

describe("Checking a view", () => {
  it("passes the guide's own examples", () => {
    assert.deepEqual(checkView(REPLY_EXAMPLE, { fetches: false }), { problems: [], notes: [] });
    assert.deepEqual(checkView(DASHBOARD_EXAMPLE, { fetches: true }), { problems: [], notes: [] });
  });

  it("says what to fix: unknown components, missing arguments, and names never defined", () => {
    const { problems } = checkView(`root = Stack([pie, stat, later])\npie = PieChart([1, 2])\nstat = Stat("Open")`, { fetches: false });
    assert.equal(problems.length, 3);
    assert.match(problems[0]!, /later/);
    assert.match(problems.join("\n"), /pie: Unknown component "PieChart"/);
    assert.match(problems.join("\n"), /stat: missing required field "\/value"/);
  });

  it("refuses a program without a root, an empty one, and one that is too long", () => {
    assert.match(checkView(`title = Heading("Hi")`, { fetches: false }).problems.join("\n"), /root/);
    assert.deepEqual(checkView("  ", { fetches: false }).problems, ["The program is empty."]);
    assert.match(checkView(`root = Stack([Text("${"x".repeat(VIEW_PROGRAM_LIMIT)}")])`, { fetches: false }).problems[0]!, /at most/);
  });

  it("notes a part nothing shows, without refusing the view", () => {
    const check = checkView(`root = Stack([a])\na = Text("Shown")\nb = Text("Not shown")`, { fetches: false });
    assert.deepEqual(check.problems, []);
    assert.match(check.notes[0]!, /b/);
  });

  it("lets only a dashboard fetch, and only with AiHub's data tools", () => {
    const fetching = `root = Stack([t])\nitems = Query("office_items", {}, {rows: []})\nt = Text("Items: " + @Count(items.rows))`;
    assert.deepEqual(checkView(fetching, { fetches: true }).problems, []);
    assert.match(checkView(fetching, { fetches: false }).problems[0]!, /can't fetch data/);
    const elsewhere = `root = Stack([t])\nmail = Query("send_email", {}, {})\nt = Text("x")`;
    assert.match(checkView(elsewhere, { fetches: true }).problems[0]!, /no data tool "send_email"/);
  });

  it("refuses anything that writes", () => {
    const writing = `root = Stack([b])\nsave = Mutation("office_items", {})\nb = Button("Save", @Run(save))`;
    assert.ok(checkView(writing, { fetches: true }).problems.some((problem) => /Mutation/.test(problem)));
  });
});

describe("The language guide", () => {
  it("explains views in AiHub's terms, without the parts that don't apply", () => {
    const guide = viewGuide("reply");
    assert.match(guide, /aihub_show_view/);
    assert.match(guide, /root = Stack/);
    assert.doesNotMatch(guide, /ENTIRE response/);
    assert.doesNotMatch(guide, /Hoisting & Streaming/);
    assert.doesNotMatch(guide, /office_items/);
  });

  it("lists the data tools for a dashboard, and no writing", () => {
    const guide = viewGuide("dashboard");
    assert.match(guide, /aihub_save_dashboard/);
    assert.match(guide, /office_items\(/);
    assert.match(guide, /source_records\(/);
    assert.doesNotMatch(guide, /## Mutation/);
  });
});

describe("@Time", () => {
  it("says how long ago, or formats a date", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    assert.equal(formatTime("2026-11-09T09:00:00Z", "ago", now), "3 h ago");
    assert.equal(formatTime("2026-11-09T11:59:40Z", "ago", now), "just now");
    assert.equal(formatTime("2026-11-06T12:00:00Z", "ago", now), "3 d ago");
    assert.equal(formatTime("not a date", "date", now), "not a date");
  });
});
