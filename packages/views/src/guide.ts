import { dataToolSpecs } from "./data.ts";
import { viewLibrary, VIEW_ROOT } from "./library.ts";

// The language guide a staff member reads before writing a view (DESIGN.md › Views). OpenUI writes
// most of it from the component library; AiHub adds what a view is for here and its rules. It comes
// from a tool when a staff member needs it, so runs that write no view don't carry it.

export type GuideKind = "reply" | "dashboard";

const REPLY_INTRO = [
  "# Views",
  "A view shows the operator what reads better as interface than as text: a chart, a table, a few key numbers, a list, a timeline, or cards. You write it as a short program in OpenUI Lang, described below, and hand it in with aihub_show_view. AiHub checks it, tells you what to fix if anything is wrong, and draws it with its own components under your reply.",
  "Your reply still says in words what matters. The view supports it, and if a view can't be drawn the operator reads your text.",
  "Write the data into the program. A view in a reply or a briefing section can't fetch anything.",
].join("\n\n");

const DASHBOARD_INTRO = [
  "# Dashboards",
  "A dashboard is a saved view the operator opens from the Dashboards tab whenever they like. You write it as a short program in OpenUI Lang, described below, and hand it in with aihub_save_dashboard. AiHub checks it and tells you what to fix if anything is wrong.",
  "A dashboard fetches fresh data from AiHub every time it opens, with Query() and the data tools listed below. They only read. You never see what they return, so write the program from their output schemas, and keep it working when a list is empty.",
].join("\n\n");

const RULES = [
  "Keep a view small and specific: the numbers, rows, or events that matter, not everything you read.",
  "Images and pages from outside AiHub may show only once the operator clicks them. Never put the operator's data in a web address.",
  "@ToAssistant puts its message in the operator's chat box for them to send. It never sends anything by itself.",
  "@ResolveItem and @DismissItem act on items by id, as the operator would on the item's card. Use only ids from data you were given.",
  "Format dates and times from data with @Time.",
];

const DASHBOARD_RULES = [
  "There are no Mutation tools: dashboards only read. Buttons can still use @ToAssistant, @OpenUrl, @ResolveItem, @DismissItem, @Set, @Reset, and @Run to refresh a Query.",
  "Give each Query defaults that render, such as {rows: []}, so the dashboard draws before its data arrives.",
];

export const REPLY_EXAMPLE =`root = Stack([title, chart, note])
title = Heading("Electricity today, SE3", 2)
chart = BarChart(["00", "01", "02", "03"], [Series("Spot price", [41.2, 38.0, 12.5, 14.1])], "Price per hour", "öre/kWh", ["02", "03"])
note = Callout("Run the dishwasher between 02:00 and 04:00: it's the cheapest stretch today.", "good")`;

export const DASHBOARD_EXAMPLE =`root = Stack([title, filters, stats, table])
$state = "open"
title = Heading("Open items", 1)
filters = Select($state, ["new", "open", "resolved"], "State")
items = Query("office_items", {states: [$state], needsOperator: true}, {rows: []})
stats = Stack([Stat("Items", @Count(items.rows)), Stat("Urgent", @Count(@Filter(items.rows, "urgency", "==", "urgent")), null, "bad")], "row")
table = Table([Col("Item", items.rows.title), Col("Staff", items.rows.staff), Col("First seen", @Each(items.rows, "row", @Time(row.firstSeenAt, "ago")))])`;

const OPENING = /^You are an AI assistant[^\n]*\n+/;
// Parts that never apply here: streaming, and Mutation, since nothing in a view writes.
const STREAMING_SECTION = /## Hoisting & Streaming \(CRITICAL\)[\s\S]*?(?=\n## )/;
const MUTATION_SECTION = /## Mutation — Write Operations[\s\S]*?(?=\n## )/;
const MUTATION_EXAMPLE = /Example — mutation \+ refresh \+ reset[^\n]*\n```\n[\s\S]*?```\n+/;

/** The guide for writing a view in a reply or briefing section, or a dashboard. */
export function viewGuide(kind: GuideKind): string {
  const dashboard = kind === "dashboard";
  const language = viewLibrary
    .prompt({
      bindings: true,
      toolCalls: dashboard,
      ...(dashboard ? { tools: dataToolSpecs(), toolExamples: [DASHBOARD_EXAMPLE] } : { examples: [REPLY_EXAMPLE] }),
      additionalRules: dashboard ? [...RULES, ...DASHBOARD_RULES] : RULES,
    })
    // The language's own opening says the whole response is a program; here the program goes into a tool call.
    .replace(OPENING, "")
    .replace(STREAMING_SECTION, "")
    .replace(MUTATION_SECTION, "")
    .replace(MUTATION_EXAMPLE, "");
  return `${dashboard ? DASHBOARD_INTRO : REPLY_INTRO}\n\n# OpenUI Lang\n\nEvery program starts with \`root = ${VIEW_ROOT}([...])\`.\n\n${language.trim()}\n`;
}
