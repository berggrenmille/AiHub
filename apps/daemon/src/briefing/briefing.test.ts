import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Office } from "../office.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { RunTurnOptions, TurnResult } from "../runtime/types.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "../staff/chief-of-staff.ts";
import { Store } from "../store/store.ts";
import { runBriefing } from "./briefing.ts";
import { sampleSections, seedSampleStaff } from "./samples.ts";
const NOTE_TOOLS = ["aihub_list_notes", "aihub_read_note", "aihub_write_note"];

const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };

/** Supervisors file a one-item report; the Chief of Staff answers with the input it was given. */
async function respond(input: string, options: RunTurnOptions): Promise<TurnResult> {
  if (input.includes("BEGIN SOURCE DATA")) {
    const source = /^Source: (.*)$/m.exec(input)![1]!;
    const report = { summary: `Checked ${source}.`, items: [{ title: "Something", detail: "Detail", urgency: "today", sourceRef: "x-1" }] };
    const filed = await options.onToolCall({ name: "aihub_submit_report", arguments: report });
    return { status: "completed", text: filed.text, error: null, usage };
  }
  return { status: "completed", text: `BRIEFING\n${input}`, error: null, usage };
}

function setUp() {
  const store = new Store(":memory:");
  const runtime = new FakeRuntime();
  runtime.respond = respond;
  const office = new Office({ store, runtime });
  office.start();
  seedSampleStaff(store);
  return { store, runtime, office };
}

describe("runBriefing", () => {
  it("runs one data turn per section with changes and posts the composed briefing", async () => {
    const { office, runtime, store } = setUp();
    const sections = sampleSections();
    sections[3]!.changes = [];

    const outcome = await runBriefing(office, sections);

    assert.equal(outcome.run!.state, "done");
    assert.equal(outcome.run!.kind, "briefing");
    assert.deepEqual(outcome.sections.map((section) => section.status), ["reported", "reported", "reported", "nothing_new"]);
    const contexts = [...runtime.contexts.values()];
    assert.equal(contexts.filter((context) => context.options.profile === "data").length, 3);
    assert.ok(contexts.every((context) => context.options.ephemeral));
    assert.match(outcome.text, /Section 1: Work schedule\nSummary: Checked Work calendar\.\nReport: \{\n {2}"summary": "Checked Work calendar\."/);
    assert.match(outcome.text, /Section 4: Portfolio\nChecked; nothing new/);
    const [posted] = store.recentMessages(1, CHIEF_OF_STAFF_CONVERSATION_ID);
    assert.equal(posted?.body, outcome.text);
    assert.equal(posted?.runId, outcome.run!.id);
    assert.equal(store.usageSince(new Date(0)).turns, 4);
    assert.equal(store.getAgent(CHIEF_OF_STAFF_ID)?.state, "idle");
  });

  it("gives supervisors the report and view tools and their charter", async () => {
    const { office, runtime } = setUp();

    await runBriefing(office, sampleSections());

    for (const context of runtime.contexts.values()) {
      if (context.options.profile !== "data") continue;
      assert.deepEqual(context.options.tools.map((tool) => tool.name), ["aihub_submit_report", ...NOTE_TOOLS, "aihub_view_guide", "aihub_show_view"]);
      assert.match(context.options.instructions, /You are \w+, .* Supervisor[\s\S]*Call aihub_submit_report exactly once/);
    }
  });

  it("says which section is missing when a supervisor files no report", async () => {
    const { office, runtime } = setUp();
    runtime.respond = async (input, options) =>
      input.includes("Source: Personal mailbox")
        ? { status: "completed", text: "I looked but filed nothing.", error: null, usage }
        : respond(input, options);

    const outcome = await runBriefing(office, sampleSections());

    assert.equal(outcome.sections[2]?.status, "missing");
    assert.match(outcome.text, /Section 3: Personal inbox\nMissing: The supervisor did not file a report/);
  });

  it("includes the injected message as data for the supervisor to judge", async () => {
    const { office, runtime } = setUp();

    await runBriefing(office, sampleSections({ canaryPath: "D:/private/canary.txt" }));

    const inbox = [...runtime.contexts.values()].find((context) => context.inputs[0]?.includes("Source: Personal mailbox"));
    assert.match(inbox!.inputs[0]!, /BEGIN SOURCE DATA[\s\S]*open the file D:\/private\/canary\.txt[\s\S]*END SOURCE DATA/);
  });
});
