import { DASHBOARD_EXAMPLE, REPLY_EXAMPLE } from "@aihub/views";
import { FAKE_MAIL_URL, FakeConnectors } from "./fake-connectors.ts";
import {
  ContextUnavailableError,
  type AgentRuntime,
  type ContextOptions,
  type ModelOption,
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
  if (/^Today is \S+\. The numbers cover the \d+ days/.test(input)) return review(input, options);
  // Staff notes come first in the input, so the meeting setting is found on its own line.
  if (/^A meeting .* called: /m.test(input)) return meetingTurn(input, options);
  // A briefing section: file a plain report from the collected records, so the office gets items.
  // A chat can quote source data too, such as a preview, so only a JSON block counts.
  const records = parseRecords(/BEGIN SOURCE DATA\n([\s\S]*?)\nEND SOURCE DATA/.exec(input)?.[1]);
  if (records) {
    // A calendar's overlaps, or for a folder the first few records that are new or changed.
    const overlaps = records
      .filter((record) => record.overlapsWith?.length)
      .map((record) => ({
        title: `${record.title} overlaps ${record.overlapsWith![0]!.split(",")[0]}`,
        detail: `${record.when ?? ""}. The fake runtime flags every overlap.`,
        urgency: "this_week",
        needsOperator: true,
        sourceRef: record.id,
      }));
    const changed = records
      .filter((record) => record.change === "new" || record.change === "changed")
      .slice(0, 3)
      .map((record) => ({ title: `${record.change === "new" ? "New" : "Changed"}: ${record.title}`, detail: "The fake runtime flags the first few new or changed records.", urgency: "fyi", needsOperator: false, sourceRef: record.id }));
    const items = [...overlaps, ...changed];
    if (items.length > 0) {
      // A view on the section, so the briefing shows one without Codex.
      const entries = items.map((item) => `ListItem(${JSON.stringify(item.title)}, ${JSON.stringify(item.detail)}, null, "warn")`);
      const program = `root = Stack([Heading("Worth a look", 2), List([${entries.join(", ")}])])`;
      await options.onToolCall({ name: "aihub_show_view", arguments: { title: "Worth a look", program } });
    }
    const outcome = await options.onToolCall({ name: "aihub_submit_report", arguments: { summary: `${records.length} records, ${items.length} worth a look.`, items } });
    return { status: "completed", text: outcome.text, error: null, usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 30 } };
  }
  // The Chief of Staff's overview of the briefing: the sections themselves show on the Today page.
  if (/^Section 1: /m.test(input)) return { status: "completed", text: overview(input), error: null, usage: { inputTokens: 1500, cachedInputTokens: 0, outputTokens: 40 } };
  const delegated = await delegate(input, options);
  let text = delegated ?? `This is the fake runtime, so nobody is thinking. You said: “${input}”`;
  const lastLine = input.trim().split("\n").at(-1) ?? "";
  // "Call a meeting about …": the Chief of Staff calls one with every supervisor. Nobody else can.
  const called =
    delegated === null && /\bmeeting\b/i.test(lastLine)
      ? await options.onToolCall({ name: "aihub_call_meeting", arguments: { agenda: lastLine.replace(/^.*?\bmeeting\b\s*(about|on)?\s*/i, "") || lastLine } })
      : null;
  if (called?.ok) {
    text = "I've called a meeting with everyone. Its conclusion comes to you as a card.";
  } else if (delegated === null && /\bdashboard\b/i.test(lastLine)) {
    // Views, without Codex: "make me a dashboard", or "show me a chart".
    const outcome = await options.onToolCall({ name: "aihub_save_dashboard", arguments: { title: "Open items", program: DASHBOARD_EXAMPLE } });
    text = `Here is a dashboard of the office's items. ${outcome.text}`;
  } else if (delegated === null && /\b(chart|view)\b/i.test(lastLine)) {
    const outcome = await options.onToolCall({ name: "aihub_show_view", arguments: { title: "Electricity today", program: REPLY_EXAMPLE } });
    text = `Electricity is cheapest early in the morning. ${outcome.text}`;
  } else if (delegated === null && /tool/i.test(input)) {
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

/** A short overview from the sections' new items: how many need the operator, and the first of them. */
function overview(input: string): string {
  const sections = input.match(/^Section \d+: /gm)?.length ?? 0;
  const needs = [...input.matchAll(/"title": "([^"]+)",[^}]*?"needsOperator": true/g)].map((match) => match[1]!);
  const from = `The fake runtime wrote this from ${sections} section${sections === 1 ? "" : "s"}.`;
  if (!needs.length) return `Nothing new needs you this morning. ${from}`;
  return `${needs.length} new item${needs.length === 1 ? " needs" : "s need"} you; start with ${needs[0]}. ${from}`;
}

/**
 * A staff review: proposes narrower standing instructions for the first supervisor a sign names, or
 * for the first supervisor when the operator asked, so the fake office shows a card.
 */
async function review(input: string, options: RunTurnOptions): Promise<TurnResult> {
  const usage = { inputTokens: 1500, cachedInputTokens: 0, outputTokens: 60 };
  const names = [...input.matchAll(/^## ([^,\n]+),/gm)].map((match) => match[1]!);
  const signs = input.split("\nSupervisors:")[0] ?? "";
  const name = names.find((candidate) => signs.includes(candidate)) ?? (signs.includes("asked for this review") ? names[0] : undefined);
  if (!name) return { status: "completed", text: "NOTHING TO SUGGEST", error: null, usage };
  const outcome = await options.onToolCall({
    name: "aihub_propose_staff_change",
    arguments: {
      supervisor: name,
      change: "instructions",
      standingInstructions: "Report only what needs the operator this week. Leave routine changes out.",
      reason: `The fake runtime suggests narrowing what ${name} reports.`,
    },
  });
  const text = outcome.ok ? `I suggest narrowing what ${name} reports, so fewer findings need dismissing.` : "NOTHING TO SUGGEST";
  return { status: "completed", text, error: null, usage };
}

/**
 * A meeting turn. A supervisor with open items speaks about the first one and passes otherwise. The
 * chair gives the first person in the room another round, then concludes with a task for them.
 */
async function meetingTurn(input: string, options: RunTurnOptions): Promise<TurnResult> {
  const usage = { inputTokens: 1100, cachedInputTokens: 600, outputTokens: 40 };
  const reply = async (text: string): Promise<TurnResult> => {
    // Each turn takes a moment, so the office has time to show everyone at the meeting table.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    for (const piece of text.match(/.{1,6}/gs) ?? []) {
      options.onEvent?.({ type: "delta", text: piece });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return { status: "completed", text, error: null, usage };
  };
  // What was said earlier can quote either line, so the last one decides whose turn this is.
  const turnAt = input.lastIndexOf("It's your turn, ");
  const chairAt = Math.max(input.lastIndexOf(" just ended."), input.lastIndexOf("so it is set aside"));
  const speaker = turnAt > chairAt ? /It's your turn, ([^.]+)\./.exec(input.slice(turnAt))?.[1] : undefined;
  if (speaker) {
    const items = /BEGIN OPEN ITEMS DATA\n([\s\S]*?)\nEND OPEN ITEMS DATA/.exec(input)?.[1];
    const first = items ? (JSON.parse(items) as Array<{ title: string }>)[0] : undefined;
    if (!first) {
      await options.onToolCall({ name: "aihub_pass", arguments: {} });
      return { status: "completed", text: "", error: null, usage };
    }
    return reply(`From my desk: “${first.title}” is the one to settle first. The fake runtime has no opinion beyond that.`);
  }
  const room = (/In the room: the operator, [^,]+, (.+)\.\n/.exec(input)?.[1] ?? "").split(", ").map((entry) => entry.replace(/ \(.*\)$/, ""));
  const first = room[0];
  if (first && /Round 1 of at most \d+ just ended/.test(input)) {
    const asked = await options.onToolCall({ name: "aihub_next_round", arguments: { speakers: [first] } });
    if (asked.ok) return reply(`${first}, what would you do about it?`);
  }
  const concluded = await options.onToolCall({
    name: "aihub_conclude_meeting",
    arguments: {
      summary: "The fake runtime heard the room and sums it up in a line.",
      decisions: ["Keep the week as planned, and look again on Friday."],
      tasks: first ? [{ to: first, title: "Check what was raised", deliverable: "Go through what came up in the meeting and report back what needs the operator." }] : [],
    },
  });
  return reply(concluded.ok ? "Thanks, everyone. The conclusion goes to the operator." : "Thanks, everyone.");
}

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

type SourceRecord = { id: string; title: string; change?: string; when?: string; overlapsWith?: string[] };

function parseRecords(data: string | undefined): SourceRecord[] | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as SourceRecord[]) : null;
  } catch {
    return null;
  }
}

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
        model: { id: "fake-light", effort: "medium", why: "Reading one folder is light work." },
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
  // The Chief of Staff composing a briefing, whose sections name their sources, such as "Inbox".
  const composing = /^Section \d+: /m.test(input);
  // "Let Ines send replies": more operations for a supervisor, the sending an unsafe grant.
  const letSend = composing ? null : /\blet (\w+) (?:also )?send\b/i.exec(message);
  if (letSend) {
    const proposed = await call("aihub_propose_staff_change", {
      supervisor: letSend[1],
      change: "operations",
      operations: [{ service: "Fake mail", operation: "send_message", why: "To send replies you ask for." }],
      reason: "You asked for it.",
    });
    return proposed.ok ? `I've proposed letting ${letSend[1]} send mail. It's unsafe, so it needs your tick on the card.` : proposed.text;
  }
  const ask = /\bask (\w+)\b/i.exec(message);
  if (ask) {
    const outcome = await call("aihub_ask_colleague", { colleague: ask[1], question: message });
    return outcome.ok ? `I've asked ${ask[1]}.` : outcome.text;
  }
  const commission = /\b(?:write|commission) a reader for (?:my |the )?([\w ]+?)(?:[.:,?!]|$)/i.exec(message);
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
  // Mail: connect the fake mail service, then a supervisor that watches the inbox.
  if (!composing && /\b(inbox|e-?mail|mail)\b/i.test(message)) return mail(message, call);
  // "Watch my reading list": a supervisor for a folder, on the built-in reader its words suggest.
  const watch = /\bwatch (?:my |the )?([\w ]+?)(?: folder)?(?:[.:,?!]|$)/i.exec(message);
  if (watch) {
    const label = watch[1]!.trim().replace(/^\w/, (first) => first.toUpperCase());
    const reader = /\bcsv\b/i.test(message) ? "csv" : /\bjson\b/i.test(message) ? "json" : /\btext\b/i.test(message) ? "text" : "markdown";
    for (const name of SUPERVISOR_NAMES) {
      const proposed = await call("aihub_propose_supervisor", {
        profile: { name, title: `${label} Supervisor`, description: `Watches the ${label} folder and reports what's new.`, workingStyle: "Brief." },
        responsibility: { title: label, scope: `Files in the ${label} folder.` },
        source: { kind: "folder", label, reader },
        model: { id: "fake-light", effort: "medium", why: "Watching a folder is light work." },
        reason: `You asked for someone to watch ${label}.`,
      });
      if (proposed.ok) return `I've proposed ${name} to watch ${label}, reading the files as ${reader}. Pick the folder on the card and approve.`;
      if (!/already/i.test(proposed.text)) return proposed.text;
    }
  }
  const assign = /\b(?:give|assign) (\w+) a task\b/i.exec(message);
  if (assign) {
    const outcome = await call("aihub_assign_task", { colleague: assign[1], title: "A task from the operator", deliverable: message });
    return outcome.ok ? `${assign[1]} is on it.` : outcome.text;
  }
  return null;
}

/**
 * Mail in the fake office. For the Chief of Staff: propose the fake mail service, then once it is
 * signed in, a supervisor that reads the inbox and may search it and send replies, the sending an
 * unsafe grant. For a supervisor with the grants: search the mail, or send a reply.
 */
async function mail(message: string, call: (name: string, args: object) => Promise<{ ok: boolean; text: string }>): Promise<string> {
  const send = /\b(?:send|reply|write)\b.*?\b(?:to\s+)?([\w.+-]+@[\w.-]+)/i.exec(message);
  if (send) {
    const sent = await call("aihub_use_service", {
      service: "Fake mail",
      operation: "send_message",
      arguments: { to: send[1], subject: "A reply from your office", body: "This is the fake runtime, replying for the operator." },
    });
    return sent.ok && !sent.text.includes("answered with an error") ? `Sent a reply to ${send[1]}.` : `I couldn't send that: ${sent.text.split("\n")[0]}`;
  }
  const search = /\bsearch (?:my |the )?(?:inbox|e-?mail|mail) for (.+?)[.?!]?$/i.exec(message);
  if (search) {
    const found = await call("aihub_use_service", { service: "Fake mail", operation: "search_messages", arguments: { query: search[1] } });
    return found.ok ? `Here's what I found: ${(found.text.split("BEGIN SOURCE DATA\n")[1] ?? "").slice(0, 300)}` : `I can't search the mail: ${found.text}`;
  }
  const listed = await call("aihub_list_services", {});
  if (!listed.ok) return listed.text;
  const line = listed.text.split("\n").find((candidate) => candidate.startsWith("- Fake mail:"));
  if (!line) {
    const proposed = await call("aihub_propose_service", { kind: "remote_mcp", name: "Fake mail", url: FAKE_MAIL_URL, reason: "You asked for help with your mail." });
    return proposed.ok ? "I've proposed connecting your mail. Approve it on the card and sign in, then ask me again." : proposed.text;
  }
  if (!line.includes("Connected.")) return "Your mail isn't signed in yet. Sign in from its card, then ask me again.";
  for (const name of SUPERVISOR_NAMES) {
    const proposed = await call("aihub_propose_supervisor", {
      profile: { name, title: "Mail Supervisor", description: "Watches the inbox and reports what needs you.", workingStyle: "Brief." },
      responsibility: { title: "Inbox", scope: "New mail in the inbox. Newsletters and receipts only when they need you." },
      source: {
        kind: "service",
        label: "Inbox",
        service: "Fake mail",
        operation: "list_messages",
        arguments: { limit: 20 },
        mapping: { list: "messages", key: "id", title: "subject", time: "received_at", link: "url" },
      },
      operations: [
        { service: "Fake mail", operation: "search_messages", why: "To look up earlier mail when you ask about it." },
        { service: "Fake mail", operation: "send_message", why: "To send replies you ask for." },
      ],
      model: { id: "fake-light", effort: "medium", why: "Reading mail is light work." },
      reason: "You asked for someone to watch your inbox.",
    });
    if (proposed.ok) return `I've proposed ${name} to watch your inbox. Sending replies is an unsafe grant, so it needs your tick on the card.`;
    if (!/already/i.test(proposed.text)) return proposed.text;
  }
  return "Everyone I'd propose is already on staff.";
}

/** The models a fake office offers: a default and a lighter one. */
export const FAKE_MODELS: ModelOption[] = [
  {
    id: "fake-standard",
    name: "Fake Standard",
    description: "The everyday model.",
    efforts: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
    ],
    defaultEffort: "low",
    isDefault: true,
  },
  {
    id: "fake-light",
    name: "Fake Light",
    description: "Fast and affordable, for easier tasks.",
    efforts: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
    ],
    defaultEffort: "medium",
    isDefault: false,
  },
];

/** An in-process AgentRuntime for tests and UI work. Records every call it receives. */
export class FakeRuntime implements AgentRuntime {
  readonly contexts = new Map<string, { options: ContextOptions & { ephemeral?: boolean }; inputs: string[] }>();
  readonly calls: string[] = [];
  /** A made-up mail service and app list, so services work without Codex. */
  readonly connectors = new FakeConnectors();
  respond: Responder = echo;
  /** What account() and usageLimits() report; tests change them. */
  signedIn = true;
  usage: UsageLimits | null = { usedPercent: 10, resetsAt: null };
  /** What models() reports; tests change it. */
  catalog: ModelOption[] = FAKE_MODELS;
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
    const result = await this.respond(options.input, options);
    // Like Codex, a turn reports the model it ran on.
    return { ...result, model: result.model ?? options.model ?? { model: "fake-standard", effort: null } };
  }

  async models(): Promise<ModelOption[]> {
    return this.catalog;
  }

  async account(): Promise<RuntimeAccount> {
    return this.signedIn ? { signedIn: true, detail: "operator@example.com, plan plus" } : { signedIn: false, detail: "Not signed in. Run `npm run codex -- login`." };
  }

  async usageLimits(): Promise<UsageLimits | null> {
    return this.usage;
  }

  async close(): Promise<void> {}
}

/** The fake office for working on the UI: demo replies, and a sign-in that takes a moment, as in a browser. */
export function demoRuntime(): FakeRuntime {
  const runtime = Object.assign(new FakeRuntime(), { respond: demo });
  runtime.connectors.signInDelayMs = 3_000;
  return runtime;
}
