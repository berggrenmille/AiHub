// What the web app decides about a view, apart from drawing it (DESIGN.md › Views): which outside
// addresses it may open or load, what a button will do, and how its numbers are laid out on an axis.
// No React here, so it can be tested on its own.

import type { View } from "@aihub/shared";

/** A web page address the operator may open: http or https only. */
export function webUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The site an address belongs to, as the operator would recognize it. */
export function siteOf(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

export type ImageSource =
  | { kind: "load"; src: string }
  /** Waits for the operator's click, naming the site it would come from. */
  | { kind: "ask"; src: string; site: string }
  | { kind: "blocked"; reason: string };

/**
 * How an image in a view loads. An image embedded in the program loads: it reaches no one. An
 * outside one loads by itself only where the view says so; otherwise it waits for a click, since
 * fetching it tells its site that the operator looked. Plain http isn't allowed by the page at all.
 */
export function imageSource(raw: unknown, outside: View["outside"]): ImageSource {
  if (typeof raw === "string" && /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(raw)) return { kind: "load", src: raw };
  const url = webUrl(raw);
  if (!url) return { kind: "blocked", reason: "Not a web address" };
  if (url.protocol !== "https:") return { kind: "blocked", reason: `${siteOf(url)} isn't served securely` };
  return outside === "load" ? { kind: "load", src: url.href } : { kind: "ask", src: url.href, site: siteOf(url) };
}

/** One step of an OpenUI action plan, as far as the operator needs to know. */
interface Step {
  type: string;
  message?: unknown;
  url?: unknown;
  name?: unknown;
  params?: unknown;
}

export interface ButtonEffect {
  /** What clicking does, in words, for the button's tooltip. */
  says: string;
  /** The site a click opens, shown on the button itself. */
  opens: string | null;
}

/** What a button does, read from its action rather than its label: a button does what it says. */
export function buttonEffect(label: string, plan: unknown): ButtonEffect {
  const steps = plan && typeof plan === "object" && Array.isArray((plan as { steps?: unknown }).steps) ? ((plan as { steps: Step[] }).steps ?? []) : null;
  if (!steps) return { says: `Puts "${label}" in the chat box`, opens: null };
  const said: string[] = [];
  let opens: string | null = null;
  for (const step of steps) {
    if (step.type === "continue_conversation") said.push(`Puts "${String(step.message ?? "")}" in the chat box`);
    else if (step.type === "open_url") {
      const url = webUrl(step.url);
      opens ??= url ? siteOf(url) : null;
      said.push(url ? `Opens ${siteOf(url)} in a new tab` : "Opens nothing: not a web address");
    } else if (step.type === "custom_action") {
      const id = (step.params as { id?: unknown } | undefined)?.id;
      if (step.name === "ResolveItem") said.push(`Resolves item ${String(id)}`);
      else if (step.name === "DismissItem") said.push(`Dismisses item ${String(id)}`);
    } else if (step.type === "run") said.push("Reloads data");
  }
  return { says: said.length ? said.join(", then ") : "Changes what the view shows", opens };
}

/** Views under each message, in the order they were handed in. */
export function viewsByMessage(views: Record<string, View>): Map<number, View[]> {
  const byMessage = new Map<number, View[]>();
  for (const view of Object.values(views).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (view.kind === "dashboard" || view.messageId === null) continue;
    byMessage.set(view.messageId, [...(byMessage.get(view.messageId) ?? []), view]);
  }
  return byMessage;
}

/** Dashboards, most recently changed first. */
export function dashboardsOf(views: Record<string, View>): View[] {
  return Object.values(views)
    .filter((view) => view.kind === "dashboard")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
}

/** Round axis ticks from zero, or from the lowest value when it is negative, covering the highest. */
export function niceTicks(values: number[], count = 4): number[] {
  const finite = values.filter(Number.isFinite);
  const low = Math.min(0, ...finite);
  const high = Math.max(0, ...finite);
  if (low === high) return [0, 1];
  const rough = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const nice = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  // Counts, such as turns, step by whole numbers.
  const step = finite.every(Number.isInteger) ? Math.max(1, Math.round(nice)) : nice;
  const ticks: number[] = [];
  for (let tick = Math.floor(low / step) * step; ; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
    if (tick >= high - step * 1e-9) return ticks;
  }
}

const compact = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** A number for an axis or a label: in full under 10,000, compact above, such as 12.9K. */
export function formatNumber(value: number): string {
  return Math.abs(value) >= 10_000 ? compact.format(value) : full.format(value);
}
