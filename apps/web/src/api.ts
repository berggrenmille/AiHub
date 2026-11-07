import type { ChatRequest, ChatResponse, DaemonEvent, StateSnapshot } from "@aihub/shared";
import type { ConnectionStatus } from "./state.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when the daemon could not be reached. */
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ApiError("Can't reach the AiHub daemon. Is it running?", 0);
  }
  if (!response.ok) throw new ApiError(await failureText(response), response.status);
  return (await response.json()) as T;
}

/** The daemon's `{ error }` text when it sent one, otherwise the status. */
async function failureText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON, such as a proxy error while the daemon is down.
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
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
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
