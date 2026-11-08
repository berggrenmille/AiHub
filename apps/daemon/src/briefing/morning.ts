import type { Office } from "../office.ts";
import { collect } from "../sources/collect.ts";
import { describeWeb } from "../staff/web.ts";
import { runBriefing, type BriefingOutcome, type BriefingSection } from "./briefing.ts";

// The real morning briefing: one section per active supervisor whose routine reports to the
// briefing, built from its granted source by the collectors, or researched on the web when it
// holds web search and no source.

/** Collects every participating responsibility's changes. Runs no model turn. */
export async function collectSections(office: Office, now = new Date()): Promise<BriefingSection[]> {
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
    if (!connection && owner.web) {
      // Nothing to collect: the supervisor searches the web for what is new.
      sections.push({ agentId: owner.id, heading: responsibility.title, source: describeWeb(owner.web), changes: [], responsibilityId: responsibility.id, research: true });
      continue;
    }
    if (!connection) {
      // Its access was removed, or never granted: say so, without a turn to find out it can't read.
      const unavailable = `${owner.name} has nothing to check: no source, and no web search. Give ${owner.name} web search on the profile card, or end the responsibility.`;
      sections.push({ agentId: owner.id, heading: responsibility.title, source: "No source", changes: [], responsibilityId: responsibility.id, unavailable });
      continue;
    }
    const collection = await collect(store, responsibility.id, connection, office.sourceContext(now));
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
      firstCheckNote: collection.firstCheckNote,
      notes: collection.notes,
      warning: collection.warning,
      onDelivered: collection.commit,
    });
  }
  return sections;
}

export async function runMorningBriefing(office: Office, options: { timeoutMs?: number; now?: Date } = {}): Promise<BriefingOutcome> {
  return runBriefing(office, await collectSections(office, options.now), options);
}
