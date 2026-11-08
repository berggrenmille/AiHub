// The UI's view of the office: a pure reducer over the daemon's snapshot and event stream.
// No React or DOM here, so it can be tested on its own.

import {
  ACTIVE_RUN_STATES,
  type ActivityEntry,
  type Agent,
  type Assignment,
  type ChatMessage,
  type ChatResponse,
  type Conversation,
  type DaemonEvent,
  type Item,
  type NoteSummary,
  type OfficeStats,
  type PolicyVersion,
  type Proposal,
  type Responsibility,
  type Routine,
  type Run,
  type RuntimeStatus,
  type SourceConnection,
  type StaffReader,
  type StateSnapshot,
} from "@aihub/shared";
import { compareAssignments, isOpenAssignment } from "./lib/assignments.ts";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

/** A reply the agent is still writing, built up from `delta` events. */
export interface StreamingReply {
  runId: string;
  conversationId: string;
  text: string;
}

export interface OfficeState {
  /** False until the first snapshot arrives. */
  loaded: boolean;
  connection: ConnectionStatus;
  /** Why the last attempt to reach the daemon failed. Cleared once the stream is connected. */
  error: string | null;
  agents: Agent[];
  conversations: Conversation[];
  /** Messages by conversation ID, oldest first. */
  messages: Record<string, ChatMessage[]>;
  runs: Record<string, Run>;
  /** Newest first. */
  activity: ActivityEntry[];
  runtime: RuntimeStatus | null;
  /** Replies in progress, by run ID. */
  streaming: Record<string, StreamingReply>;
  responsibilities: Responsibility[];
  connections: SourceConnection[];
  routines: Routine[];
  /** Newest first. */
  proposals: Proposal[];
  items: Item[];
  /** Open and waiting assignments first, newest first, then settled ones, most recently settled first. */
  assignments: Assignment[];
  /** Readers staff wrote, newest first. */
  readers: StaffReader[];
  /** The office policy's versions and proposals, newest first. */
  policies: PolicyVersion[];
  /**
   * Staff who left since the last snapshot, such as workers whose results were accepted. A late
   * update for one of them doesn't bring them back.
   */
  departed: string[];
  /** Summaries only. A note's body is fetched when it is opened. */
  notes: NoteSummary[];
  /** Null until the first snapshot arrives. */
  office: OfficeStats | null;
}

export type OfficeAction =
  | { type: "snapshot"; snapshot: StateSnapshot }
  | { type: "event"; event: DaemonEvent }
  /** The response to `POST /api/chat`. */
  | { type: "sent"; response: ChatResponse }
  | { type: "connection"; status: ConnectionStatus; error: string | null };

/** How many activity entries the feed keeps. */
export const ACTIVITY_LIMIT = 200;
/** How many settled assignments the view keeps. Open ones are always kept. */
export const SETTLED_ASSIGNMENT_LIMIT = 200;

export const initialOfficeState: OfficeState = {
  loaded: false,
  connection: "connecting",
  error: null,
  agents: [],
  conversations: [],
  messages: {},
  runs: {},
  activity: [],
  runtime: null,
  streaming: {},
  responsibilities: [],
  connections: [],
  routines: [],
  proposals: [],
  items: [],
  assignments: [],
  readers: [],
  policies: [],
  departed: [],
  notes: [],
  office: null,
};

export function isActive(run: Run): boolean {
  return ACTIVE_RUN_STATES.includes(run.state);
}

export function officeReducer(state: OfficeState, action: OfficeAction): OfficeState {
  switch (action.type) {
    case "snapshot":
      return applySnapshot(state, action.snapshot);
    case "event":
      return applyEvent(state, action.event);
    case "sent": {
      // The stream is the authority on run state. By the time this response arrives the stream may
      // already have moved the run past the `queued` it carries, so only add a run not seen yet.
      const { message, run } = action.response;
      const withMessage = addMessage(state, message);
      if (state.runs[run.id]) return withMessage;
      return { ...withMessage, runs: { ...withMessage.runs, [run.id]: run } };
    }
    case "connection":
      if (state.connection === action.status && state.error === action.error) return state;
      return { ...state, connection: action.status, error: action.error };
  }
}

/** A snapshot replaces everything it covers. Streamed text isn't in it, so keep only replies still in progress. */
function applySnapshot(state: OfficeState, snapshot: StateSnapshot): OfficeState {
  const messages: Record<string, ChatMessage[]> = {};
  for (const message of [...snapshot.messages].sort(byId)) {
    (messages[message.conversationId] ??= []).push(message);
  }
  const runs = Object.fromEntries(snapshot.runs.map((run) => [run.id, run]));
  const answered = new Set(snapshot.messages.filter((m) => m.author === "agent" && m.runId).map((m) => m.runId));
  const streaming = Object.fromEntries(
    Object.entries(state.streaming).filter(([runId]) => {
      const run = runs[runId];
      return run !== undefined && isActive(run) && !answered.has(runId);
    }),
  );
  return {
    ...state,
    loaded: true,
    agents: snapshot.agents,
    conversations: snapshot.conversations,
    messages,
    runs,
    activity: [...snapshot.activity].sort(byIdDescending).slice(0, ACTIVITY_LIMIT),
    runtime: snapshot.runtime,
    streaming,
    responsibilities: snapshot.responsibilities ?? [],
    connections: snapshot.connections ?? [],
    routines: snapshot.routines ?? [],
    proposals: [...(snapshot.proposals ?? [])].sort(newestFirst),
    items: snapshot.items ?? [],
    assignments: keepAssignments(snapshot.assignments ?? []),
    readers: [...(snapshot.readers ?? [])].sort(newestFirst),
    policies: [...(snapshot.policies ?? [])].sort((a, b) => b.id - a.id),
    departed: [],
    notes: snapshot.notes ?? [],
    office: snapshot.office ?? null,
  };
}

function applyEvent(state: OfficeState, event: DaemonEvent): OfficeState {
  switch (event.type) {
    case "agent":
      if (state.departed.includes(event.agent.id)) return state;
      return { ...state, agents: upsert(state.agents, event.agent, (agent) => agent.id) };
    case "agent_left": {
      // Leaving the list is what walks the character out of the office.
      const agents = state.agents.filter((agent) => agent.id !== event.agentId);
      if (agents.length === state.agents.length && state.departed.includes(event.agentId)) return state;
      return { ...state, agents, departed: [...state.departed.filter((id) => id !== event.agentId), event.agentId] };
    }
    case "assignment": {
      const existing = state.assignments.find((assignment) => assignment.id === event.assignment.id);
      if (existing && existing.updatedAt > event.assignment.updatedAt) return state;
      return { ...state, assignments: keepAssignments(upsert(state.assignments, event.assignment, (assignment) => assignment.id)) };
    }
    case "run": {
      const runs = { ...state.runs, [event.run.id]: event.run };
      if (isActive(event.run) || !state.streaming[event.run.id]) return { ...state, runs };
      return { ...state, runs, streaming: without(state.streaming, event.run.id) };
    }
    case "message":
      return addMessage(state, event.message);
    case "delta": {
      const run = state.runs[event.runId];
      if (run && !isActive(run)) return state;
      const text = (state.streaming[event.runId]?.text ?? "") + event.text;
      const reply = { runId: event.runId, conversationId: event.conversationId, text };
      return { ...state, streaming: { ...state.streaming, [event.runId]: reply } };
    }
    case "activity": {
      if (state.activity.some((entry) => entry.id === event.entry.id)) return state;
      const activity = [event.entry, ...state.activity].sort(byIdDescending).slice(0, ACTIVITY_LIMIT);
      return { ...state, activity };
    }
    case "runtime":
      return { ...state, runtime: event.runtime };
    case "responsibility":
      return { ...state, responsibilities: upsert(state.responsibilities, event.responsibility, (r) => r.id) };
    case "connection":
      return { ...state, connections: upsert(state.connections, event.connection, (c) => c.id) };
    case "routine":
      return { ...state, routines: upsert(state.routines, event.routine, (r) => r.id) };
    case "proposal": {
      const existing = state.proposals.find((proposal) => proposal.id === event.proposal.id);
      // A decision is final: an older copy of a decided proposal, such as a late HTTP response, can't reopen it.
      if (existing && existing.status !== "pending" && event.proposal.status === "pending") return state;
      return { ...state, proposals: upsert(state.proposals, event.proposal, (p) => p.id).sort(newestFirst) };
    }
    case "item": {
      const existing = state.items.find((item) => item.id === event.item.id);
      if (existing && existing.updatedAt > event.item.updatedAt) return state;
      return { ...state, items: upsert(state.items, event.item, (item) => item.id) };
    }
    case "policy": {
      // A decided version never goes back to waiting, so a late copy of the proposal is older.
      const known = state.policies.find((policy) => policy.id === event.policy.id);
      if (known && known.status !== "pending" && event.policy.status === "pending") return state;
      return { ...state, policies: upsert(state.policies, event.policy, (policy) => policy.id).sort((a, b) => b.id - a.id) };
    }
    case "reader": {
      const existing = state.readers.find((reader) => reader.id === event.reader.id);
      if (existing && existing.updatedAt > event.reader.updatedAt) return state;
      return { ...state, readers: upsert(state.readers, event.reader, (reader) => reader.id).sort(newestFirst) };
    }
    case "conversation": {
      // Arrives on the stream and in the response to opening the chat; either can come first.
      const existing = state.conversations.find((conversation) => conversation.id === event.conversation.id);
      if (existing && existing.agentId === event.conversation.agentId && existing.title === event.conversation.title) return state;
      return { ...state, conversations: upsert(state.conversations, event.conversation, (conversation) => conversation.id) };
    }
    case "note": {
      const notes = upsertNote(state.notes, event.note);
      return notes === state.notes ? state : { ...state, notes };
    }
    case "office":
      return { ...state, office: event.office };
    case "resync":
      // The connection reloads the snapshot and applies it; until then the current view stands.
      return state;
    default:
      // An event from a newer daemon. The next snapshot brings whatever it changed.
      return state;
  }
}

/**
 * Upserts a note summary by path. A staff member has one profile note, named after it, so a new
 * profile path for the same owner means a rename and the old path is gone from the vault. The
 * stream has no removal event, so drop the old one here.
 */
function upsertNote(notes: NoteSummary[], note: NoteSummary): NoteSummary[] {
  const existing = notes.find((candidate) => candidate.path === note.path);
  if (existing && existing.updatedAt > note.updatedAt) return notes;
  const kept =
    note.kind === "profile" && note.ownerId !== null
      ? notes.filter((other) => !(other.kind === "profile" && other.ownerId === note.ownerId && other.path !== note.path))
      : notes;
  return upsert(kept, note, (candidate) => candidate.path);
}

const ROLE_ORDER: Record<Agent["role"], number> = { chief_of_staff: 0, supervisor: 1, worker: 2 };

/** Agents in roster order: each manager followed by its reports, with their depth in the hierarchy. */
export function rosterOrder(agents: Agent[]): Array<{ agent: Agent; depth: number }> {
  const ids = new Set(agents.map((agent) => agent.id));
  const reports = new Map<string | null, Agent[]>();
  const sorted = [...agents].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  for (const agent of sorted) {
    const managerId = agent.managerId !== null && ids.has(agent.managerId) ? agent.managerId : null;
    reports.set(managerId, [...(reports.get(managerId) ?? []), agent]);
  }
  const ordered: Array<{ agent: Agent; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (managerId: string | null, depth: number) => {
    for (const agent of reports.get(managerId) ?? []) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      ordered.push({ agent, depth });
      visit(agent.id, depth + 1);
    }
  };
  visit(null, 0);
  // Agents whose managers form a loop never hang from a root. Show them anyway.
  for (const agent of sorted) if (!seen.has(agent.id)) ordered.push({ agent, depth: 0 });
  return ordered;
}

/** Adds a message once, in ID order. An agent's reply replaces the streamed text of its run. */
function addMessage(state: OfficeState, message: ChatMessage): OfficeState {
  const list = state.messages[message.conversationId] ?? [];
  if (list.some((existing) => existing.id === message.id)) return state;
  const messages = { ...state.messages, [message.conversationId]: [...list, message].sort(byId) };
  const finished = message.author === "agent" && message.runId !== null && state.streaming[message.runId];
  return { ...state, messages, streaming: finished ? without(state.streaming, message.runId!) : state.streaming };
}

/** In the snapshot's order, with every open assignment and the most recent settled ones. */
function keepAssignments(assignments: Assignment[]): Assignment[] {
  const sorted = [...assignments].sort(compareAssignments);
  const open = sorted.filter(isOpenAssignment);
  return [...open, ...sorted.slice(open.length, open.length + SETTLED_ASSIGNMENT_LIMIT)];
}

/** Replaces the record with the same key in place, or appends it. */
function upsert<T>(list: T[], record: T, key: (value: T) => string | number): T[] {
  const id = key(record);
  const index = list.findIndex((candidate) => key(candidate) === id);
  return index === -1 ? [...list, record] : list.with(index, record);
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function byId(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
}

function byIdDescending(a: { id: number }, b: { id: number }): number {
  return b.id - a.id;
}

function newestFirst(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}
