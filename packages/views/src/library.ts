import { z } from "zod";
import { action, createLibrary, defineAction, defineComponent, defineFunction, markReactive } from "@openuidev/lang-core";

// AiHub's view components (DESIGN.md › Views). Staff write views in OpenUI Lang with these and
// nothing else; the daemon checks every program against them, and the web app draws each one with
// its own renderer. The schemas live here so both sides agree on them. Key order is the order of
// positional arguments in a program.

const tone = z.enum(["neutral", "good", "warn", "bad"]).describe("Color: good is green, warn amber, bad red.");
const cell = z.union([z.string(), z.number(), z.null()]);

/** A prop the program can bind to a $variable, such as the value a Select sets. */
function bound<T extends z.ZodType>(schema: T): T {
  markReactive(schema);
  return schema;
}

export const Text = defineComponent({
  name: "Text",
  description: "A paragraph of plain text.",
  props: z.object({
    text: z.string(),
    tone: tone.optional(),
    size: z.enum(["small", "normal", "large"]).optional(),
  }),
  component: null,
});

export const Heading = defineComponent({
  name: "Heading",
  description: "A heading. Level 1 is the largest; use 2 or 3 inside cards.",
  props: z.object({ text: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
  component: null,
});

export const Badge = defineComponent({
  name: "Badge",
  description: "A short label, such as a status.",
  props: z.object({ text: z.string(), tone: tone.optional() }),
  component: null,
});

export const Callout = defineComponent({
  name: "Callout",
  description: "A highlighted note, such as a warning or the one thing that needs action.",
  props: z.object({ text: z.string(), tone: tone.optional(), title: z.string().optional() }),
  component: null,
});

export const Stat = defineComponent({
  name: "Stat",
  description: "One number that matters, with a label and an optional detail line.",
  props: z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    detail: z.string().optional(),
    tone: tone.optional(),
  }),
  component: null,
});

export const Col = defineComponent({
  name: "Col",
  description: "A table column: its label and one value per row.",
  props: z.object({
    label: z.string(),
    values: z.array(cell),
    align: z.enum(["left", "right"]).optional().describe("right suits numbers."),
  }),
  component: null,
});

export const Table = defineComponent({
  name: "Table",
  description: "A table built from columns of equal length.",
  props: z.object({ columns: z.array(Col.ref), caption: z.string().optional() }),
  component: null,
});

export const Series = defineComponent({
  name: "Series",
  description: "A named row of numbers for a chart, one per label.",
  props: z.object({ name: z.string(), values: z.array(z.number().nullable()), tone: tone.optional() }),
  component: null,
});

const chartProps = z.object({
  labels: z.array(z.string()).describe("The x axis, such as hours or days."),
  series: z.array(Series.ref),
  title: z.string().optional(),
  unit: z.string().optional().describe('Such as "öre/kWh" or "h".'),
  highlight: z.array(z.string()).optional().describe("Labels to mark, such as the cheapest hours."),
});

export const BarChart = defineComponent({
  name: "BarChart",
  description: "Bars per label. Several series sit side by side.",
  props: chartProps,
  component: null,
});

export const LineChart = defineComponent({
  name: "LineChart",
  description: "Lines over the labels, for a trend over time.",
  props: chartProps.clone(),
  component: null,
});

export const ListItem = defineComponent({
  name: "ListItem",
  description: "One entry of a List.",
  props: z.object({
    title: z.string(),
    detail: z.string().optional(),
    meta: z.string().optional().describe("A short note on the right, such as a time or a source."),
    tone: tone.optional(),
    url: z.string().optional().describe("A page the title links to."),
  }),
  component: null,
});

export const List = defineComponent({
  name: "List",
  description: "A list of entries, such as news stories or open items.",
  props: z.object({ items: z.array(ListItem.ref), ordered: z.boolean().optional() }),
  component: null,
});

export const TimelineEvent = defineComponent({
  name: "TimelineEvent",
  description: "One entry of a Timeline.",
  props: z.object({ time: z.string(), title: z.string(), detail: z.string().optional(), tone: tone.optional() }),
  component: null,
});

export const Timeline = defineComponent({
  name: "Timeline",
  description: "Events in time order, such as a day's meetings.",
  props: z.object({ events: z.array(TimelineEvent.ref) }),
  component: null,
});

export const Link = defineComponent({
  name: "Link",
  description: "A link to a web page. It opens in a new tab when the operator clicks it.",
  props: z.object({ label: z.string(), url: z.string() }),
  component: null,
});

export const Image = defineComponent({
  name: "Image",
  description: "A picture from a web address, such as a story's photo. Some views show it only once the operator clicks it.",
  props: z.object({ url: z.string(), alt: z.string(), caption: z.string().optional() }),
  component: null,
});

export const Button = defineComponent({
  name: "Button",
  description: "A button that runs an action when the operator clicks it.",
  props: z.object({ label: z.string(), action: action(), variant: z.enum(["primary", "secondary"]).optional() }),
  component: null,
});

export const Select = defineComponent({
  name: "Select",
  description: "A dropdown that sets a $variable, for filtering what the view shows.",
  props: z.object({ value: bound(z.string()), options: z.array(z.string()), label: z.string().optional() }),
  component: null,
});

export const Toggle = defineComponent({
  name: "Toggle",
  description: "A switch that sets a $variable to true or false.",
  props: z.object({ value: bound(z.boolean()), label: z.string() }),
  component: null,
});

// Containers hold any component, themselves included, so their children are read lazily.
const leaves = [Text, Heading, Badge, Callout, Stat, Table, BarChart, LineChart, List, Timeline, Link, Image, Button, Select, Toggle];

function content(): z.ZodType {
  return z.union([...leaves.map((component) => component.ref), Stack.ref, Card.ref, Tabs.ref] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

export const Stack = defineComponent({
  name: "Stack",
  description: "Lays its children out in a column, or in a row that wraps on narrow screens. The root of every view.",
  props: z.object({
    get children() {
      return z.array(content());
    },
    direction: z.enum(["column", "row"]).optional(),
    gap: z.enum(["small", "normal", "large"]).optional(),
  }),
  component: null,
});

export const Card = defineComponent({
  name: "Card",
  description: "A titled panel that groups related content.",
  props: z.object({
    title: z.string(),
    get children() {
      return z.array(content());
    },
    detail: z.string().optional().describe("A line under the title."),
  }),
  component: null,
});

export const Tab = defineComponent({
  name: "Tab",
  description: "One tab of Tabs.",
  props: z.object({
    label: z.string(),
    get children() {
      return z.array(content());
    },
  }),
  component: null,
});

export const Tabs = defineComponent({
  name: "Tabs",
  description: "Tabs the operator switches between, each with its own content.",
  props: z.object({ tabs: z.array(Tab.ref) }),
  component: null,
});

export const VIEW_COMPONENTS = [...leaves, Col, Series, ListItem, TimelineEvent, Stack, Card, Tab, Tabs];

/** The props a component's renderer gets, such as `PropsOf<typeof Table>`. */
export type PropsOf<C extends { props: z.ZodType }> = z.infer<C["props"]>;

/** The component every view starts from: `root = Stack([...])`. */
export const VIEW_ROOT = "Stack";

export const ResolveItem = defineAction({
  name: "ResolveItem",
  description: "Resolve an open item by its id, as the operator would on its card.",
  params: z.object({ id: z.number(), note: z.string().optional() }),
});

export const DismissItem = defineAction({
  name: "DismissItem",
  description: "Dismiss an item by its id: it doesn't matter to the operator.",
  params: z.object({ id: z.number() }),
});

export const VIEW_ACTIONS = [ResolveItem, DismissItem];

export const Time = defineFunction({
  name: "Time",
  description: 'Formats an ISO date and time in the operator\'s time zone. style: "date", "time", "datetime" (default), or "ago".',
  params: z.object({ at: z.string(), style: z.enum(["date", "time", "datetime", "ago"]).optional() }),
  returns: z.string(),
  fn: ({ at, style }) => formatTime(at, style ?? "datetime"),
});

export const VIEW_FUNCTIONS = [Time];

/** The library as the daemon uses it: for checking programs and writing the guide. Nothing renders here. */
export const viewLibrary = createLibrary({ components: VIEW_COMPONENTS, actions: VIEW_ACTIONS, functions: VIEW_FUNCTIONS, root: VIEW_ROOT, id: "aihub" });

/** AiHub's time zone, wherever the browser is (DESIGN.md › Scheduling and reporting). */
export const VIEW_TIME_ZONE = "Europe/Stockholm";

export function formatTime(at: string, style: "date" | "time" | "datetime" | "ago", now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  if (style === "ago") {
    const minutes = Math.round((now - date.getTime()) / 60_000);
    if (Math.abs(minutes) < 1) return "just now";
    const [amount, unit] = Math.abs(minutes) < 60 ? [minutes, "min"] : Math.abs(minutes) < 48 * 60 ? [Math.round(minutes / 60), "h"] : [Math.round(minutes / 1440), "d"];
    return amount >= 0 ? `${amount} ${unit} ago` : `in ${-amount} ${unit}`;
  }
  const options: Intl.DateTimeFormatOptions =
    style === "date"
      ? { weekday: "short", day: "numeric", month: "short" }
      : style === "time"
        ? { hour: "2-digit", minute: "2-digit" }
        : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return date.toLocaleString("en-GB", { ...options, timeZone: VIEW_TIME_ZONE });
}
