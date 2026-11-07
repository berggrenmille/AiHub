import {
  ContextUnavailableError,
  type AgentRuntime,
  type ContextOptions,
  type RunTurnOptions,
  type RuntimeAccount,
  type TurnResult,
  type UsageLimits,
} from "./types.ts";

type Responder = (input: string, options: RunTurnOptions) => Promise<TurnResult>;

/** Echoes the input back in a few streamed pieces. */
export const echo: Responder = async (input, options) => {
  const text = `Echo: ${input}`;
  for (const piece of text.match(/.{1,8}/gs) ?? []) options.onEvent?.({ type: "delta", text: piece });
  return { status: "completed", text, error: null, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } };
};

/**
 * For working on the UI without Codex (`AIHUB_RUNTIME=fake`): streams slowly enough to watch,
 * and calls the first offered tool when the message asks for it, such as "who is on staff? use a tool".
 */
export const demo: Responder = async (input, options) => {
  // A briefing section: file a plain report from the collected records, so the office gets items.
  const data = /BEGIN SOURCE DATA\n([\s\S]*?)\nEND SOURCE DATA/.exec(input)?.[1];
  if (data) {
    const records = JSON.parse(data) as Array<{ id: string; title: string; when?: string; overlapsWith?: string[] }>;
    const items = records
      .filter((record) => record.overlapsWith?.length)
      .map((record) => ({
        title: `${record.title} overlaps ${record.overlapsWith![0]!.split(",")[0]}`,
        detail: `${record.when ?? ""}. The fake runtime flags every overlap.`,
        urgency: "this_week",
        sourceRef: record.id,
      }));
    const outcome = await options.onToolCall({ name: "aihub_submit_report", arguments: { summary: `${records.length} records, ${items.length} overlaps.`, items } });
    return { status: "completed", text: outcome.text, error: null, usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 30 } };
  }
  const delegated = await delegate(input, options);
  let text = delegated ?? `This is the fake runtime, so nobody is thinking. You said: “${input}”`;
  if (delegated === null && /tool/i.test(input)) {
    const outcome = await options.onToolCall({ name: "aihub_get_roster", arguments: {} });
    text += `

The roster tool returned: ${outcome.text}`;
  }
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    options.onEvent?.({ type: "delta", text: piece });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return { status: "completed", text, error: null, usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 40 } };
};

const HELPER_NAMES = ["Pip", "Juno", "Otto", "Wren"];
const TOOLSMITH_NAMES = ["Ada", "Linus", "Grace", "Alan"];
const SUPERVISOR_NAMES = ["Ines", "Hugo", "Maja", "Sixten"];

/** The fake toolsmith's reader: one record per line, split on tabs, semicolons, or runs of spaces. */
const LINE_READER = String.raw`function read(file) {
  return file.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split(/\t|;|\s{2,}/).map((part) => part.trim()).filter(Boolean);
      const fields = {};
      parts.forEach((part, index) => { fields["column " + (index + 1)] = part; });
      return { key: line, title: parts.slice(0, 3).join(" · "), fields };
    });
}`;

const SAMPLE_EXPORT = "# Exported 2026-11-07\n2026-11-02  ICA Maxi  -412,50\n2026-11-03  Salary  25 000,00\n2026-11-04  Vattenfall  -1 180,00\n";

/**
 * Delegation for the fake office, so the UI shows it without Codex. In chat, "ask Elin when …" asks
 * a colleague and "give Elin a task: …" assigns one; mention a helper and the supervisor recruits a
 * worker, and accepts its work in the follow-up. Returns null when the input calls for none of it.
 */
async function delegate(input: string, options: RunTurnOptions): Promise<string | null> {
  const call = (name: string, args: object) => options.onToolCall({ name, arguments: args });
  const between = (marker: string) => new RegExp(`BEGIN ${marker} DATA\\n([\\s\\S]*?)\\nEND ${marker} DATA`).exec(input)?.[1] ?? "";

  // A toolsmith's reader came back: propose the supervisor who will use it.
  const reader = /delivered "Reader: ([^"]+)"/.exec(input)?.[1];
  if (reader && between("DELIVERABLE")) {
    for (const name of SUPERVISOR_NAMES) {
      const proposed = await call("aihub_propose_supervisor", {
        profile: { name, title: `${reader} Supervisor`, description: `Watches the ${reader} folder and reports what stands out.`, workingStyle: "Brief." },
        responsibility: { title: reader, scope: `Files in the ${reader} folder.` },
        source: { kind: "folder", label: reader, reader },
        reason: "The reader is ready, so someone can watch the folder.",
      });
      if (proposed.ok) return `The ${reader} reader is ready. I've proposed ${name} to watch the folder: pick it on the card, preview what the reader finds, and approve.`;
    }
  }
  // A chat follow-up: pass on what came back.
  const back = between("ANSWER") || between("DELIVERABLE");
  if (back) return `Here's what came back: ${back.split("\n")[0]}`;
  // Answering a colleague.
  // Answers and work take a few seconds, so the office has time to show the visit or the worker.
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  if (input.includes("asks you a question")) {
    await pause(4_000);
    return `Nothing in my records stands in the way of that. (A fake answer to “${between("QUESTION").slice(0, 80)}”.)`;
  }
  // A toolsmith writes its reader: test it on the samples, then hand it in.
  if (/hands you a task: Reader: /.test(input)) {
    await pause(3_000);
    const tested = await call("aihub_test_reader", { code: LINE_READER });
    if (!tested.ok) return tested.text;
    await pause(3_000);
    const submitted = await call("aihub_submit_reader", { code: LINE_READER, notes: "One record per line, split on tabs, semicolons, or wide spaces. Lines starting with # are skipped." });
    return submitted.ok ? "Each line becomes a record, with its columns as fields. It can't tell a header row from data. (A fake reader.)" : submitted.text;
  }
  // A task: a supervisor asked for a helper recruits one; anyone else, workers included, does the work.
  if (input.includes("hands you a task")) {
    const task = between("TASK");
    const fromChief = input.includes("(Chief of Staff) hands you a task");
    if (fromChief && /helper|worker/i.test(task)) {
      for (const name of HELPER_NAMES) {
        const recruit = { name, title: "Helper", description: "Goes through the records for one task.", taskTitle: "Go through the records", task };
        // Share the work calendar when the supervisor has it; recruit without a source otherwise.
        const hired = (await call("aihub_recruit_worker", { ...recruit, sources: ["Work calendar"] })).ok || (await call("aihub_recruit_worker", recruit)).ok;
        if (hired) return `${name} is on it.`;
      }
    }
    await pause(fromChief ? 2_000 : 8_000);
    return `Done: ${task.split("\n")[0]?.slice(0, 120)} (A fake deliverable.)`;
  }
  // Following up a task: accept every worker's work, then deliver.
  if (input.includes("BEGIN RESULT DATA")) {
    for (const [, worker] of input.matchAll(/^(\w+)'s work on "/gm)) await call("aihub_review_work", { worker, verdict: "accept" });
    return "Checked the team's work. (A fake deliverable.)";
  }
  // The operator's request in chat.
  const message = input.includes("The operator's new message:\n") ? input.split("The operator's new message:\n").at(-1)! : input.slice(input.lastIndexOf("\n\n") + 1).trim();
  const ask = /\bask (\w+)\b/i.exec(message);
  if (ask) {
    const outcome = await call("aihub_ask_colleague", { colleague: ask[1], question: message });
    return outcome.ok ? `I've asked ${ask[1]}.` : outcome.text;
  }
  const commission = /\b(?:write|commission) a reader for (?:my |the )?([\w ]+?)(?:[.:,]|$)/i.exec(message);
  if (commission) {
    const name = commission[1]!.trim().replace(/^\w/, (first) => first.toUpperCase());
    for (const toolsmith of TOOLSMITH_NAMES) {
      const outcome = await call("aihub_commission_reader", {
        name,
        format: `${message}\nOne transaction per line: date, text, and amount, separated by two or more spaces. Lines starting with # are comments.`,
        pattern: "*.txt",
        samples: [{ name: "sample.txt", text: SAMPLE_EXPORT }],
        toolsmith,
      });
      if (outcome.ok) return `${toolsmith} is writing a reader for ${name}.`;
      if (!/already called/.test(outcome.text)) return outcome.text;
    }
  }
  const assign = /\b(?:give|assign) (\w+) a task\b/i.exec(message);
  if (assign) {
    const outcome = await call("aihub_assign_task", { colleague: assign[1], title: "A task from the operator", deliverable: message });
    return outcome.ok ? `${assign[1]} is on it.` : outcome.text;
  }
  return null;
}

/** An in-process AgentRuntime for tests and UI work. Records every call it receives. */
export class FakeRuntime implements AgentRuntime {
  readonly contexts = new Map<string, { options: ContextOptions & { ephemeral?: boolean }; inputs: string[] }>();
  readonly calls: string[] = [];
  respond: Responder = echo;
  private nextContext = 1;

  constructor(private readonly prefix = "ctx") {}

  async startContext(options: ContextOptions & { ephemeral?: boolean }): Promise<string> {
    const id = `${this.prefix}-${this.nextContext++}`;
    this.contexts.set(id, { options, inputs: [] });
    this.calls.push(`start ${id}`);
    return id;
  }

  /** Resumes contexts this runtime knows, as Codex resumes threads saved in CODEX_HOME. */
  async resumeContext(contextId: string, options: ContextOptions): Promise<void> {
    this.calls.push(`resume ${contextId}`);
    const context = this.contexts.get(contextId);
    if (!context) throw new ContextUnavailableError(contextId, "no saved thread");
    context.options = options;
  }

  async runTurn(contextId: string, options: RunTurnOptions): Promise<TurnResult> {
    this.calls.push(`turn ${contextId}`);
    const context = this.contexts.get(contextId);
    if (!context) throw new ContextUnavailableError(contextId, "not loaded");
    context.inputs.push(options.input);
    return this.respond(options.input, options);
  }

  async account(): Promise<RuntimeAccount> {
    return { signedIn: true, detail: "operator@example.com, plan plus" };
  }

  async usageLimits(): Promise<UsageLimits | null> {
    return { usedPercent: 10, resetsAt: null };
  }

  async close(): Promise<void> {}
}
