import { useCallback, useEffect, useReducer, useRef } from "react";
import { connectOffice, sendChat } from "./api.ts";
import { initialOfficeState, officeReducer } from "./state.ts";

/** The office state, kept current from the daemon, and a way to send chat messages. */
export function useOffice() {
  const [state, dispatch] = useReducer(officeReducer, initialOfficeState);
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(
    () =>
      connectOffice({
        onSnapshot: (snapshot) => dispatch({ type: "snapshot", snapshot }),
        onEvent: (event) => dispatch({ type: "event", event }),
        onStatus: (status, error) => dispatch({ type: "connection", status, error }),
      }),
    [],
  );

  // One request at a time, so messages sent in quick succession reach the daemon in order.
  const send = useCallback((conversationId: string, text: string): Promise<void> => {
    const sending = sendQueue.current.then(() => sendChat({ conversationId, text }));
    sendQueue.current = sending.catch(() => undefined);
    return sending.then((response) => dispatch({ type: "sent", response }));
  }, []);

  return { state, send };
}
