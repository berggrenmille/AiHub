// The Today page (DESIGN.md › Layout): what needs the operator first, then the latest briefing by
// supervisor. Pure functions over records, so they can be tested on their own.

import type { Briefing, BriefingItem, BriefingSectionRecord, BriefingSectionStatus, ChatMessage, Item, Meeting, MessageKind, ModelOption, PolicyVersion, Proposal, Service, StaffChange } from "@aihub/shared";
import { byPressure, waitsForOperator } from "./inbox.ts";
import { meetingStatus } from "./meetings.ts";
import { pendingPolicy } from "./policy.ts";
import { staffChangeTitle } from "./staff-changes.ts";

export const SECTION_STATUS_LABELS: Record<BriefingSectionStatus, string> = {
  reported: "Reported",
  nothing_new: "Nothing new",
  unavailable: "Source unavailable",
  missing: "Missing",
};

/** A decision waiting for the operator: a card in a chat, or a meeting's conclusion. */
export interface Decision {
  key: string;
  kind: "meeting" | "proposal" | "staff_change" | "policy" | "service";
  title: string;
  /** Where it waits: the meeting, or the chat its card was posted in. Null when that chat isn't loaded. */
  conversationId: string | null;
  createdAt: string;
}

interface DecisionRecords {
  meetings: Meeting[];
  proposals: Proposal[];
  staffChanges: StaffChange[];
  policies: PolicyVersion[];
  services: Service[];
  messages: Record<string, ChatMessage[]>;
}

/** Every decision waiting for the operator, oldest first: the longest wait goes first. */
export function decisionsWaiting(records: DecisionRecords, models: ModelOption[] | null = null): Decision[] {
  const cardChat = (kind: MessageKind, refId: string) => cardConversation(records.messages, kind, refId);
  const decisions: Decision[] = [
    ...records.meetings
      .filter((meeting) => meetingStatus(meeting) === "needs_you")
      .map((meeting) => ({ key: `meeting:${meeting.id}`, kind: "meeting" as const, title: `Approve the conclusion of "${meeting.title}"`, conversationId: meeting.id, createdAt: meeting.createdAt })),
    ...records.proposals
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => ({
        key: `proposal:${proposal.id}`,
        kind: "proposal" as const,
        title: `Hire ${proposal.payload.profile.name}, ${proposal.payload.profile.title}`,
        conversationId: cardChat("proposal", proposal.id),
        createdAt: proposal.createdAt,
      })),
    ...records.staffChanges
      .filter((change) => change.status === "pending")
      .map((change) => ({
        key: `staff_change:${change.id}`,
        kind: "staff_change" as const,
        title: staffChangeTitle(change, models),
        conversationId: cardChat("staff_change", String(change.id)),
        createdAt: change.createdAt,
      })),
    ...records.services
      .filter((service) => service.status === "proposed")
      .map((service) => ({ key: `service:${service.id}`, kind: "service" as const, title: `Connect ${service.name}`, conversationId: cardChat("service", service.id), createdAt: service.createdAt })),
  ];
  const policy = pendingPolicy(records.policies);
  if (policy) {
    decisions.push({ key: `policy:${policy.id}`, kind: "policy", title: "A change to the office policy", conversationId: cardChat("policy", String(policy.id)), createdAt: policy.createdAt });
  }
  return decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

/** The chat a card was posted in, among the loaded messages. */
function cardConversation(messages: Record<string, ChatMessage[]>, kind: MessageKind, refId: string): string | null {
  for (const [conversationId, list] of Object.entries(messages)) {
    if (list.some((message) => message.kind === kind && message.refId === refId)) return conversationId;
  }
  return null;
}

/** Items that wait for the operator, most pressing first. */
export function itemsWaiting(items: Item[]): Item[] {
  return items.filter(waitsForOperator).sort(byPressure);
}

/** How an item a briefing told stands now: still waiting, closed since, or only worth knowing. */
export type ToldState = "waiting" | "resolved" | "dismissed" | "known";

export function toldState(told: BriefingItem, items: ReadonlyMap<number, Item>): ToldState {
  const item = told.id === null ? undefined : items.get(told.id);
  if (item?.state === "resolved" || item?.state === "dismissed") return item.state;
  if (item ? waitsForOperator(item) : told.needsOperator) return "waiting";
  return "known";
}

/** What a section asks of the operator: its items that still wait, and its open questions. */
export function sectionAsks(section: BriefingSectionRecord, items: ReadonlyMap<number, Item>): number {
  const waiting = [...section.fresh, ...section.carried].filter((told) => toldState(told, items) === "waiting").length;
  return waiting + section.decisions.length;
}

/** Sections that ask something of the operator first, then the rest, each group in the briefing's order. */
export function sectionsInOrder(sections: BriefingSectionRecord[], items: ReadonlyMap<number, Item>): BriefingSectionRecord[] {
  const asking = sections.filter((section) => sectionAsks(section, items) > 0 || section.status === "missing" || section.status === "unavailable");
  return [...asking, ...sections.filter((section) => !asking.includes(section))];
}

/** A line under the page's title, such as "3 things need you." */
export function needsLine(waiting: number): string {
  if (waiting === 0) return "Nothing needs you right now.";
  return `${waiting} thing${waiting === 1 ? " needs" : "s need"} you.`;
}

/** What a briefing still asks of the operator: its items that wait, and its questions. */
export function briefingAsks(briefing: Briefing, items: ReadonlyMap<number, Item>): number {
  return briefing.sections.reduce((sum, section) => sum + sectionAsks(section, items), 0);
}
