import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { DaemonEvent, UpdateAgentRequest } from "@aihub/shared";
import {
  approveProposal,
  connectOffice,
  declineProposal,
  dismissItem,
  putNote,
  resolveItem,
  runRoutine,
  sendChat,
  updateAgent,
} from "./api.ts";
import { initialOfficeState, officeReducer } from "./state.ts";

/** Commands the operator gives. Each applies the daemon's answer at once; the stream confirms it. */
export interface OfficeCommands {
  send(conversationId: string, text: string): Promise<void>;
  updateAgent(agentId: string, changes: UpdateAgentRequest): Promise<void>;
  approve(proposalId: string, sourcePath?: string): Promise<void>;
  decline(proposalId: string): Promise<void>;
  dismiss(itemId: number): Promise<void>;
  resolve(itemId: number, note?: string): Promise<void>;
  runRoutine(routineId: string): Promise<void>;
  saveNote(path: string, body: string): Promise<void>;
}

/** The office state, kept current from the daemon, and the operator's commands. */
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

  const commands = useMemo<OfficeCommands>(() => {
    const apply = (event: DaemonEvent) => dispatch({ type: "event", event });
    return {
      send,
      updateAgent: async (agentId, changes) => apply({ type: "agent", agent: await updateAgent(agentId, changes) }),
      approve: async (proposalId, sourcePath) =>
        apply({ type: "proposal", proposal: await approveProposal(proposalId, sourcePath ? { sourcePath } : {}) }),
      decline: async (proposalId) => apply({ type: "proposal", proposal: await declineProposal(proposalId) }),
      dismiss: async (itemId) => apply({ type: "item", item: await dismissItem(itemId) }),
      resolve: async (itemId, note) => apply({ type: "item", item: await resolveItem(itemId, note ? { note } : {}) }),
      runRoutine: async (routineId) => {
        await runRoutine(routineId);
      },
      saveNote: async (path, body) => apply({ type: "note", note: await putNote(path, { body }) }),
    };
  }, [send]);

  return { state, commands };
}
