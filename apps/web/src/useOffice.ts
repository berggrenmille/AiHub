import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Conversation, DaemonEvent, Meeting, ModelChoice, ModelOption, SourcePreview, UpdateAgentRequest, WebGrant } from "@aihub/shared";
import {
  approvePolicy,
  approveProposal,
  approveService,
  approveStaffChange,
  approveMeeting,
  callMeeting,
  endMeeting,
  sayInMeeting,
  declineService,
  refreshService,
  removeService,
  revokeServiceGrant,
  revokeSource,
  signInService,
  connectOffice,
  declinePolicy,
  declineProposal,
  declineStaffChange,
  dismissItem,
  listModels,
  openChat,
  previewProposal,
  renameTopic,
  startTopic,
  putNote,
  removeView,
  resolveItem,
  runRoutine,
  runStaffReview,
  sendChat,
  setAgentModel,
  setWebGrant,
  updateAgent,
  updateRoutine,
  viewData,
  writePolicy,
} from "./api.ts";
import { initialOfficeState, officeReducer } from "./state.ts";

/** Commands the operator gives. Each applies the daemon's answer at once; the stream confirms it. */
export interface OfficeCommands {
  send(conversationId: string, text: string): Promise<void>;
  /** Opens the operator's general chat with a staff member and returns it. */
  openChat(agentId: string): Promise<Conversation>;
  /** Starts a chat on a topic with a staff member and returns it. */
  startTopic(agentId: string, title?: string): Promise<Conversation>;
  renameTopic(conversationId: string, title: string): Promise<void>;
  /** Calls a meeting and returns it. Without participants, every supervisor comes. */
  callMeeting(agenda: string, participantIds?: string[]): Promise<Meeting>;
  sayInMeeting(meetingId: string, text: string): Promise<void>;
  approveMeeting(meetingId: string, outcomeId: number): Promise<void>;
  endMeeting(meetingId: string): Promise<void>;
  updateAgent(agentId: string, changes: UpdateAgentRequest): Promise<void>;
  setWeb(agentId: string, web: WebGrant | null): Promise<void>;
  /** Loads the models Codex offers into `models`. */
  loadModels(): Promise<ModelOption[]>;
  setModel(agentId: string, choice: ModelChoice): Promise<void>;
  setWeekends(routineId: string, weekends: boolean): Promise<void>;
  savePolicy(body: string): Promise<void>;
  approvePolicy(policyId: number): Promise<void>;
  declinePolicy(policyId: number): Promise<void>;
  /** `unsafe` holds the keys of the unsafe grants the operator ticked. */
  approveStaffChange(changeId: number, unsafe?: string[]): Promise<void>;
  declineStaffChange(changeId: number): Promise<void>;
  /** Asks the Chief of Staff to review the staff now. */
  reviewStaff(): Promise<void>;
  /** What a proposal's source would read at a path. Changes nothing. */
  preview(proposalId: string, sourcePath: string): Promise<SourcePreview>;
  /** `unsafe` holds the keys of the unsafe grants the operator ticked. */
  approve(proposalId: string, sourcePath?: string, unsafe?: string[]): Promise<void>;
  decline(proposalId: string): Promise<void>;
  approveService(serviceId: string, unsafe: string[]): Promise<void>;
  declineService(serviceId: string): Promise<void>;
  /** Starts a sign-in and returns the address to open in the browser. */
  signInService(serviceId: string): Promise<string>;
  refreshService(serviceId: string): Promise<void>;
  removeService(serviceId: string): Promise<void>;
  revokeServiceGrant(grantId: number): Promise<void>;
  revokeSource(connectionId: string, agentId: string): Promise<void>;
  dismiss(itemId: number, note?: string): Promise<void>;
  resolve(itemId: number, note?: string): Promise<void>;
  runRoutine(routineId: string): Promise<void>;
  saveNote(path: string, body: string): Promise<void>;
  /** Runs a dashboard's data tool. */
  viewData(tool: string, args: Record<string, unknown>): Promise<unknown>;
  removeDashboard(viewId: string): Promise<void>;
}

/** The office state, kept current from the daemon, and the operator's commands. */
export function useOffice() {
  const [state, dispatch] = useReducer(officeReducer, initialOfficeState);
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());
  // Not part of the office's state: the daemon asks Codex for them on request.
  const [models, setModels] = useState<ModelOption[] | null>(null);

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
      openChat: async (agentId) => {
        const { conversation } = await openChat(agentId);
        apply({ type: "conversation", conversation });
        return conversation;
      },
      startTopic: async (agentId, title) => {
        const { conversation } = await startTopic(agentId, title);
        apply({ type: "conversation", conversation });
        return conversation;
      },
      renameTopic: async (conversationId, title) => {
        const { conversation } = await renameTopic(conversationId, title);
        apply({ type: "conversation", conversation });
      },
      callMeeting: async (agenda, participantIds) => {
        const meeting = await callMeeting(agenda, participantIds);
        dispatch({ type: "meeting_called", meeting });
        return meeting;
      },
      sayInMeeting: async (meetingId, text) => apply({ type: "message", message: await sayInMeeting(meetingId, text) }),
      approveMeeting: async (meetingId, outcomeId) => apply({ type: "meeting", meeting: await approveMeeting(meetingId, outcomeId) }),
      endMeeting: async (meetingId) => apply({ type: "meeting", meeting: await endMeeting(meetingId) }),
      updateAgent: async (agentId, changes) => apply({ type: "agent", agent: await updateAgent(agentId, changes) }),
      setWeb: async (agentId, web) => apply({ type: "agent", agent: await setWebGrant(agentId, web) }),
      loadModels: async () => {
        const { models } = await listModels();
        setModels(models);
        return models;
      },
      setModel: async (agentId, choice) => apply({ type: "agent", agent: await setAgentModel(agentId, choice) }),
      setWeekends: async (routineId, weekends) => apply({ type: "routine", routine: await updateRoutine(routineId, { weekends }) }),
      savePolicy: async (body) => apply({ type: "policy", policy: await writePolicy(body) }),
      approvePolicy: async (policyId) => apply({ type: "policy", policy: await approvePolicy(policyId) }),
      declinePolicy: async (policyId) => apply({ type: "policy", policy: await declinePolicy(policyId) }),
      approveStaffChange: async (changeId, unsafe) => apply({ type: "staff_change", change: await approveStaffChange(changeId, unsafe) }),
      declineStaffChange: async (changeId) => apply({ type: "staff_change", change: await declineStaffChange(changeId) }),
      reviewStaff: () => runStaffReview(),
      preview: (proposalId, sourcePath) => previewProposal(proposalId, { sourcePath }),
      approve: async (proposalId, sourcePath, unsafe) =>
        apply({ type: "proposal", proposal: await approveProposal(proposalId, { ...(sourcePath && { sourcePath }), ...(unsafe?.length && { unsafe }) }) }),
      decline: async (proposalId) => apply({ type: "proposal", proposal: await declineProposal(proposalId) }),
      approveService: async (serviceId, unsafe) => apply({ type: "service", service: await approveService(serviceId, unsafe.length ? { unsafe } : {}) }),
      declineService: async (serviceId) => apply({ type: "service", service: await declineService(serviceId) }),
      signInService: async (serviceId) => (await signInService(serviceId)).url,
      refreshService: async (serviceId) => apply({ type: "service", service: await refreshService(serviceId) }),
      removeService: async (serviceId) => apply({ type: "service", service: await removeService(serviceId) }),
      revokeServiceGrant: (grantId) => revokeServiceGrant(grantId),
      revokeSource: (connectionId, agentId) => revokeSource(connectionId, agentId),
      dismiss: async (itemId, note) => apply({ type: "item", item: await dismissItem(itemId, note ? { note } : {}) }),
      resolve: async (itemId, note) => apply({ type: "item", item: await resolveItem(itemId, note ? { note } : {}) }),
      runRoutine: async (routineId) => {
        await runRoutine(routineId);
      },
      saveNote: async (path, body) => apply({ type: "note", note: await putNote(path, { body }) }),
      viewData: (tool, args) => viewData({ tool, args }),
      removeDashboard: async (viewId) => {
        await removeView(viewId);
        apply({ type: "view_removed", viewId });
      },
    };
  }, [send]);

  return { state, commands, models };
}
