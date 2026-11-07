// What a character shows on the floor, derived from records: the run state, a short afterglow when
// a run ends, the reply it is streaming, and the counts for the badges.

import type { Agent, Item, Run, RunState, Urgency } from "@aihub/shared";
import type { StreamingReply } from "../state.ts";

export type Presence = RunState | "idle";

/** How long a finished run's check mark stays up. */
export const DONE_GLOW_MS = 6_000;
/** How long a failed run's red marker stays up, unless another run starts. */
export const FAILED_MARK_MS = 15 * 60_000;

const ACTIVE: ReadonlySet<Presence> = new Set(["queued", "collecting", "working", "reviewing", "waiting_for_access", "waiting_for_approval"]);

/** The agent's runs, newest first. */
export function runsOf(agentId: string, runs: Record<string, Run>): Run[] {
  return Object.values(runs)
    .filter((run) => run.agentId === agentId)
    .sort((a, b) => (b.startedAt ?? b.queuedAt).localeCompare(a.startedAt ?? a.queuedAt) || b.id.localeCompare(a.id));
}

/** The run the agent is busy with, if any: the newest one still in progress. */
export function currentRun(agentId: string, runs: Record<string, Run>): Run | null {
  return runsOf(agentId, runs).find((run) => ACTIVE.has(run.state)) ?? null;
}

/**
 * What the character acts out. The agent's own state wins while something is in progress. Once
 * idle, a run that just finished shows a check for a moment, and a failed one keeps a red marker
 * for a while, so the operator notices it.
 */
export function presenceOf(agent: Agent, runs: Record<string, Run>, now: number): Presence {
  if (agent.state !== "idle") return agent.state;
  const latest = runsOf(agent.id, runs)[0];
  if (!latest?.finishedAt) return "idle";
  const age = now - Date.parse(latest.finishedAt);
  if (latest.state === "done" && age >= 0 && age < DONE_GLOW_MS) return "done";
  if (latest.state === "failed" && age >= 0 && age < FAILED_MARK_MS) return "failed";
  return "idle";
}

/** The reply the agent is writing right now, for its speech bubble. */
export function speechOf(agentId: string, streaming: Record<string, StreamingReply>, runs: Record<string, Run>): StreamingReply | null {
  for (const reply of Object.values(streaming)) {
    if (runs[reply.runId]?.agentId === agentId) return reply;
  }
  return null;
}

/** The last `limit` characters of a long reply, cut at a word, for a bubble. */
export function bubbleText(text: string, limit = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const tail = clean.slice(clean.length - limit);
  const space = tail.indexOf(" ");
  return `…${space > 0 && space < 24 ? tail.slice(space + 1) : tail}`;
}

export const URGENCY_ORDER: Record<Urgency, number> = { urgent: 0, today: 1, this_week: 2, fyi: 3 };

/** New and open items per responsibility, with the most pressing urgency among them. */
export function openItemCounts(items: Item[]): Map<string, { count: number; fresh: number; top: Urgency }> {
  const counts = new Map<string, { count: number; fresh: number; top: Urgency }>();
  for (const item of items) {
    if (item.state !== "new" && item.state !== "open") continue;
    const entry = counts.get(item.responsibilityId) ?? { count: 0, fresh: 0, top: "fyi" as Urgency };
    entry.count++;
    if (item.state === "new") entry.fresh++;
    if (URGENCY_ORDER[item.urgency] < URGENCY_ORDER[entry.top]) entry.top = item.urgency;
    counts.set(item.responsibilityId, entry);
  }
  return counts;
}
