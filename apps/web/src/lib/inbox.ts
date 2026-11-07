// The items board: new and open items grouped by responsibility, most pressing first, and the
// recently closed ones apart (DESIGN.md › Staff and work model: Item).

import type { Item, Responsibility } from "@aihub/shared";
import { URGENCY_ORDER } from "./presence.ts";

export interface ItemGroup {
  responsibilityId: string;
  responsibility: Responsibility | null;
  items: Item[];
}

const isOpen = (item: Item) => item.state === "new" || item.state === "open";

/** Most urgent first; among equals, new before open, then the newest. */
export function byPressure(a: Item, b: Item): number {
  return (
    URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
    (a.state === "new" ? 0 : 1) - (b.state === "new" ? 0 : 1) ||
    b.firstSeenAt.localeCompare(a.firstSeenAt) ||
    b.id - a.id
  );
}

/** Open items by responsibility. Groups with the most pressing item come first. */
export function groupOpenItems(items: Item[], responsibilities: Responsibility[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const item of items.filter(isOpen).sort(byPressure)) {
    let group = groups.get(item.responsibilityId);
    if (!group) {
      group = { responsibilityId: item.responsibilityId, responsibility: responsibilities.find((r) => r.id === item.responsibilityId) ?? null, items: [] };
      groups.set(item.responsibilityId, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => byPressure(a.items[0]!, b.items[0]!));
}

/** Resolved and dismissed items, most recently closed first. */
export function closedItems(items: Item[]): Item[] {
  return items.filter((item) => !isOpen(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
}

export function openCount(items: Item[]): { open: number; fresh: number; urgent: number } {
  let open = 0;
  let fresh = 0;
  let urgent = 0;
  for (const item of items) {
    if (!isOpen(item)) continue;
    open++;
    if (item.state === "new") fresh++;
    if (item.urgency === "urgent") urgent++;
  }
  return { open, fresh, urgent };
}
