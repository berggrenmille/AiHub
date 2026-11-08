// Items that need the operator (DESIGN.md › Staff and work model: Item): which wait, in what order,
// and the recently closed ones. The Today page lists them; the rest are only worth knowing, and the
// briefing tells the operator about them.

import type { Item } from "@aihub/shared";
import { URGENCY_ORDER } from "./presence.ts";

const isOpen = (item: Item) => item.state === "new" || item.state === "open";
/** Open, and the operator has to act on it. */
export const waitsForOperator = (item: Item) => item.needsOperator && isOpen(item);

/** Most urgent first; among equals, new before open, then the newest. */
export function byPressure(a: Item, b: Item): number {
  return (
    URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
    (a.state === "new" ? 0 : 1) - (b.state === "new" ? 0 : 1) ||
    b.firstSeenAt.localeCompare(a.firstSeenAt) ||
    b.id - a.id
  );
}

/** Resolved and dismissed items, most recently closed first. */
export function closedItems(items: Item[]): Item[] {
  return items.filter((item) => item.needsOperator && !isOpen(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
}

export function openCount(items: Item[]): { open: number; fresh: number; urgent: number } {
  let open = 0;
  let fresh = 0;
  let urgent = 0;
  for (const item of items) {
    if (!waitsForOperator(item)) continue;
    open++;
    if (item.state === "new") fresh++;
    if (item.urgency === "urgent") urgent++;
  }
  return { open, fresh, urgent };
}
