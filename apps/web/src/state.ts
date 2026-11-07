// The UI's view of the office: a pure reducer over the daemon's snapshot and event stream.
// No React or DOM here, so it can be tested on its own.

import {
  ACTIVE_RUN_STATES,
  type ActivityEntry,
  type Agent,
  type ChatMessage,
  type ChatResponse,
  type Conversation,
  type DaemonEvent,
  type Run,
  type RuntimeStatus,
  type StateSnapshot,
} from "@aihub/shared";

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
}

export type OfficeAction =
  | { type: "snapshot"; snapshot: StateSnapshot }
  | { type: "event"; event: DaemonEvent }
  /** The response to `POST /api/chat`. */
  | { type: "sent"; response: ChatResponse }
  | { type: "connection"; status: ConnectionStatus; error: string | null };

/** How many activity entries the feed keeps. */
export const ACTIVITY_LIMIT = 200;

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
  };
}

function applyEvent(state: OfficeState, event: DaemonEvent): OfficeState {
  switch (event.type) {
    case "agent": {
      const index = state.agents.findIndex((agent) => agent.id === event.agent.id);
      const agents = index === -1 ? [...state.agents, event.agent] : state.agents.with(index, event.agent);
      return { ...state, agents };
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
    case "resync":
      // The connection reloads the snapshot and applies it; until then the current view stands.
      return state;
  }
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
