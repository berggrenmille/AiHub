// Which chat the drawer shows and who it is with (DESIGN.md › The office experience: every staff
// member can be talked to). Pure functions over records, so they can be tested on their own.

import type { Agent, Conversation } from "@aihub/shared";

/** The conversation the drawer shows: the one the operator opened, else the Chief of Staff's. */
export function shownConversation(conversations: Conversation[], chiefId: string | null, openId: string | null): Conversation | null {
  const opened = openId ? conversations.find((conversation) => conversation.id === openId) : undefined;
  if (opened) return opened;
  return chiefId ? (conversations.find((conversation) => conversation.agentId === chiefId) ?? null) : null;
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
