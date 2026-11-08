// Which chat the drawer shows and who it is with (DESIGN.md › The office experience: every staff
// member can be talked to). Pure functions over records, so they can be tested on their own.

import type { Agent, ChatMessage, Conversation } from "@aihub/shared";

/** The conversation the drawer shows: the one the operator opened, else the Chief of Staff's general chat. */
export function shownConversation(conversations: Conversation[], chiefId: string | null, openId: string | null): Conversation | null {
  const opened = openId ? conversations.find((conversation) => conversation.id === openId) : undefined;
  if (opened) return opened;
  return chiefId ? (conversations.find((conversation) => conversation.agentId === chiefId && !conversation.topic) ?? null) : null;
}

/**
 * Who a chat is with, and whether they are still on staff. Someone who has left is off the roster,
 * so the drawer shows them as last seen, or failing that from the conversation alone.
 */
export function chatPartner(conversation: Conversation, agents: Agent[], lastSeen: ReadonlyMap<string, Agent>): { agent: Agent; present: boolean } {
  const current = agents.find((agent) => agent.id === conversation.agentId);
  if (current) return { agent: current, present: true };
  const seen = lastSeen.get(conversation.agentId);
  if (seen) return { agent: { ...seen, state: "idle" }, present: false };
  return {
    agent: {
      id: conversation.agentId,
      name: conversation.title,
      title: "",
      description: "",
      workingStyle: "",
      // Staff who come and go are seeded from their name, as the daemon seeds them.
      avatar: conversation.title,
      role: "worker",
      managerId: null,
      profile: "conversation",
      hiredAt: "",
      experience: 0,
      state: "idle",
      connectionIds: [],
      web: null,
      model: null,
      effort: null,
    },
    present: false,
  };
}

/**
 * A line for a chat with a supervisor or worker: they answer from what they can read, not from the
 * whole office as the Chief of Staff does. Null for the Chief of Staff.
 */
export function chatScope(agent: Agent): string | null {
  if (agent.role === "chief_of_staff") return null;
  if (agent.connectionIds.length === 0) return `${agent.name} reads no sources, so answers come from ${agent.name}'s own work and notes.`;
  return `Answers come from ${agent.name}'s own sources and notes.`;
}

/** What a chat is called in a list of someone's chats: a topic's name, or General. */
export function chatName(conversation: Conversation): string {
  return conversation.topic ? conversation.title : "General";
}

/** When a chat last moved: its newest message, else when it started. ISO times sort as text. */
export function lastActivity(conversation: Conversation, messages: readonly ChatMessage[] | undefined): string {
  return messages?.at(-1)?.createdAt ?? conversation.createdAt;
}

/** One staff member's chats: the general one first, then topics, the most recently active first. */
export function chatsOf(agentId: string, conversations: Conversation[], messages: Record<string, ChatMessage[]>): Conversation[] {
  const theirs = conversations.filter((conversation) => conversation.agentId === agentId);
  const general = theirs.filter((conversation) => !conversation.topic);
  const topics = theirs
    .filter((conversation) => conversation.topic)
    .sort((a, b) => lastActivity(b, messages[b.id]).localeCompare(lastActivity(a, messages[a.id])) || b.id.localeCompare(a.id));
  return [...general, ...topics];
}

/**
 * Staff messages the operator hasn't seen, by chat. `seen` holds the newest message seen in each;
 * a chat the operator is looking at has none unread.
 */
export function unreadCounts(
  conversations: Conversation[],
  messages: Record<string, ChatMessage[]>,
  seen: ReadonlyMap<string, number>,
  visibleId: string | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    if (conversation.id === visibleId) continue;
    const after = seen.get(conversation.id) ?? 0;
    const unread = (messages[conversation.id] ?? []).filter((message) => message.author === "agent" && message.id > after).length;
    if (unread > 0) counts.set(conversation.id, unread);
  }
  return counts;
}
