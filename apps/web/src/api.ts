import type {
  Agent,
  ApproveProposalRequest,
  ChatRequest,
  ChatResponse,
  DaemonEvent,
  Item,
  Note,
  NoteSummary,
  OpenChatResponse,
  PolicyVersion,
  Proposal,
  ResolveItemRequest,
  Routine,
  RunRoutineResponse,
  SourcePreview,
  StateSnapshot,
  UpdateAgentRequest,
  UpdateRoutineRequest,
  WebGrant,
  WriteNoteRequest,
} from "@aihub/shared";
import type { ConnectionStatus } from "./state.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when the daemon could not be reached. */
    readonly status: number,
    /** True when the daemon has no such endpoint yet, as opposed to no such record. */
    readonly unsupported = false,
  ) {
    super(message);
  }
}

/** Shown when the daemon doesn't have an endpoint the UI already uses. */
export const UNSUPPORTED_MESSAGE = "This daemon can't do that yet. It arrives with a daemon update.";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ApiError("Can't reach the AiHub daemon. Is it running?", 0);
  }
  if (!response.ok) {
    const failure = await failureOf(response);
    throw new ApiError(failure.unsupported ? UNSUPPORTED_MESSAGE : failure.text, response.status, failure.unsupported);
  }
  return (await response.json()) as T;
}

/**
 * The daemon's `{ error }` text when it sent one, otherwise the status. A 404 from a route the
 * daemon doesn't have comes from Fastify's own handler, `{ message: "Route POST:/x not found" }`,
 * which tells it apart from a 404 for a record that doesn't exist.
 */
async function failureOf(response: Response): Promise<{ text: string; unsupported: boolean }> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const unsupported = response.status === 404 && typeof body.message === "string" && /^Route \S+ not found$/.test(body.message);
    if (unsupported) return { text: body.message as string, unsupported };
    if (typeof body.error === "string") return { text: body.error, unsupported: false };
  } catch {
    // Not JSON, such as a proxy error while the daemon is down.
  }
  return { text: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`, unsupported: false };
}

/** A message for an error from any API call. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Sets the token cookie that every other API call needs. */
export async function startSession(): Promise<void> {
  try {
    await request<{ ok: true }>("/api/session");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError(`Couldn't start a session with the AiHub daemon: ${detail}`, error instanceof ApiError ? error.status : 0);
  }
}

export function loadState(): Promise<StateSnapshot> {
  return request<StateSnapshot>("/api/state");
}

/** Records the message and queues the reply. The reply itself arrives on the event stream. */
export function sendChat(body: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", json("POST", body));
}

/** Edits a staff member's profile. A name another staff member has answers 409. */
export function updateAgent(agentId: string, body: UpdateAgentRequest): Promise<Agent> {
  return request<Agent>(`/api/agents/${encodeURIComponent(agentId)}`, json("PATCH", body));
}

/** Gives a staff member web search, or with null takes it away. A site that isn't one answers 400. */
export function setWebGrant(agentId: string, web: WebGrant | null): Promise<Agent> {
  const path = `/api/agents/${encodeURIComponent(agentId)}/web`;
  return request<Agent>(path, web ? json("PUT", web) : json("DELETE", {}));
}

/** The URL of a note: its vault path, each segment encoded. */
export function noteUrl(path: string): string {
  return `/api/notes/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function getNote(path: string): Promise<Note> {
  return request<Note>(noteUrl(path));
}

/** Writes a note as the operator. Profile notes answer 409: they follow the staff card. */
export function putNote(path: string, body: WriteNoteRequest): Promise<NoteSummary> {
  return request<NoteSummary>(noteUrl(path), json("PUT", body));
}

/** Opens the operator's chat with a staff member, or finds the one already open. */
export function openChat(agentId: string): Promise<OpenChatResponse> {
  return request<OpenChatResponse>(`/api/agents/${encodeURIComponent(agentId)}/chat`, json("POST", {}));
}

/** What a proposed source would read at a path. Nothing is created; a 400 says why it can't be read. */
export function previewProposal(proposalId: string, body: { sourcePath: string }): Promise<SourcePreview> {
  return request<SourcePreview>(`/api/proposals/${encodeURIComponent(proposalId)}/preview`, json("POST", body));
}

export function approveProposal(proposalId: string, body: ApproveProposalRequest): Promise<Proposal> {
  return request<Proposal>(`/api/proposals/${encodeURIComponent(proposalId)}/approve`, json("POST", body));
}

export function declineProposal(proposalId: string): Promise<Proposal> {
  return request<Proposal>(`/api/proposals/${encodeURIComponent(proposalId)}/decline`, json("POST", {}));
}

export function dismissItem(itemId: number): Promise<Item> {
  return request<Item>(`/api/items/${itemId}/dismiss`, json("POST", {}));
}

export function resolveItem(itemId: number, body: ResolveItemRequest): Promise<Item> {
  return request<Item>(`/api/items/${itemId}/resolve`, json("POST", body));
}

/** Writes the office policy. The same text as now answers 400. */
export function writePolicy(body: string): Promise<PolicyVersion> {
  return request<PolicyVersion>("/api/policy", json("PUT", { body }));
}

export function approvePolicy(policyId: number): Promise<PolicyVersion> {
  return request<PolicyVersion>(`/api/policy/${policyId}/approve`, json("POST", {}));
}

export function declinePolicy(policyId: number): Promise<PolicyVersion> {
  return request<PolicyVersion>(`/api/policy/${policyId}/decline`, json("POST", {}));
}

/** Has a scheduled routine run on weekends too, or on weekdays only. */
export function updateRoutine(routineId: string, body: UpdateRoutineRequest): Promise<Routine> {
  return request<Routine>(`/api/routines/${encodeURIComponent(routineId)}`, json("PATCH", body));
}

/** Starts a routine now. Its run arrives on the event stream. */
export function runRoutine(routineId: string): Promise<RunRoutineResponse> {
  return request<RunRoutineResponse>(`/api/routines/${encodeURIComponent(routineId)}/run`, json("POST", {}));
}

export interface OfficeConnectionHandlers {
  onSnapshot(snapshot: StateSnapshot): void;
  onEvent(event: DaemonEvent): void;
  onStatus(status: ConnectionStatus, error: string | null): void;
}

/**
 * Follows the office: starts a session, loads `/api/state`, then follows `/api/events` from the
 * snapshot's last event (DESIGN.md › Architecture: load the current state before continuing the
 * stream). EventSource reconnects by itself and sends Last-Event-ID. On `resync`, or when the
 * browser gives up on the stream, this loads the state again and opens a new stream.
 * Returns a function that stops following.
 */
export function connectOffice(handlers: OfficeConnectionHandlers): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let connectedOnce = false;

  const closeStream = () => {
    source?.close();
    source = null;
  };

  const retryLater = (error: unknown) => {
    if (stopped) return;
    failures++;
    handlers.onStatus(connectedOnce ? "reconnecting" : "connecting", error instanceof Error ? error.message : String(error));
    const delay = Math.min(1000 * 2 ** (failures - 1), 15_000);
    retryTimer = setTimeout(() => void load(true), delay);
  };

  const follow = (after: string) => {
    const events = new EventSource(`/api/events?after=${encodeURIComponent(after)}`);
    source = events;
    events.onopen = () => {
      failures = 0;
      connectedOnce = true;
      handlers.onStatus("connected", null);
    };
    events.onmessage = (message: MessageEvent<string>) => {
      let event: DaemonEvent;
      try {
        event = JSON.parse(message.data) as DaemonEvent;
      } catch {
        return;
      }
      if (event.type === "resync") {
        closeStream();
        handlers.onStatus("reconnecting", null);
        void load(false);
        return;
      }
      handlers.onEvent(event);
    };
    events.onerror = () => {
      if (events !== source) return;
      // CONNECTING means the browser is retrying by itself. CLOSED means it gave up, for example
      // after an HTTP error, so start over from the session.
      if (events.readyState === EventSource.CLOSED) {
        closeStream();
        retryLater(new Error("Lost the connection to the AiHub daemon."));
      } else {
        handlers.onStatus("reconnecting", null);
      }
    };
  };

  const load = async (withSession: boolean) => {
    try {
      if (withSession) await startSession();
      const snapshot = await loadState();
      if (stopped) return;
      handlers.onSnapshot(snapshot);
      follow(snapshot.lastEventId);
    } catch (error) {
      retryLater(error);
    }
  };

  handlers.onStatus("connecting", null);
  void load(true);

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    closeStream();
  };
}
