import type { Office } from "../office.ts";
import { collect } from "../sources/collect.ts";
import { runBriefing, type BriefingOutcome, type BriefingSection } from "./briefing.ts";

// The real morning briefing: one section per active supervisor whose routine reports to the
// briefing, built from its granted source by the collectors.

/** Collects every participating responsibility's changes. Runs no model turn. */
export function collectSections(office: Office, now = new Date()): BriefingSection[] {
  const { store, bus } = office;
  for (const ended of store.endExpiredResponsibilities()) bus.publish({ type: "responsibility", responsibility: ended });

  const sections: BriefingSection[] = [];
  for (const routine of store.listRoutines()) {
    if (routine.trigger.type !== "briefing" || routine.paused || !routine.responsibilityId) continue;
    // An ended responsibility, such as an expired mandate, reports nothing more.
    if (!store.isResponsibilityActive(routine.responsibilityId)) continue;
    const owner = store.getAgent(routine.ownerId);
    const responsibility = store.getResponsibility(routine.responsibilityId)!;
    if (!owner) continue;

    const [connection] = store.connectionsOf(owner.id);
    if (!connection) {
      sections.push({ agentId: owner.id, heading: responsibility.title, source: "No source", changes: [], responsibilityId: responsibility.id });
      continue;
    }
    const collection = collect(store, responsibility.id, connection, now);
    bus.publish({ type: "connection", connection: collection.connection });
    sections.push({
      agentId: owner.id,
      heading: responsibility.title,
      source: connection.label,
      changes: collection.records,
      responsibilityId: responsibility.id,
      identities: collection.identities,
      unavailable: collection.unavailable,
      firstCheck: collection.firstCheck,
      onDelivered: collection.commit,
    });
  }
  return sections;
}

export function runMorningBriefing(office: Office, options: { timeoutMs?: number; now?: Date } = {}): Promise<BriefingOutcome> {
  return runBriefing(office, collectSections(office, options.now), options);
}
