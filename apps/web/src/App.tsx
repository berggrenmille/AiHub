import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@aihub/shared";
import { ActivityLog, ActivityTicker, Toasts } from "./components/Activity.tsx";
import { AssignmentsDrawer } from "./components/Assignments.tsx";
import { ChatDrawer } from "./components/ChatDrawer.tsx";
import { Dashboards } from "./components/Dashboards.tsx";
import { Hud, type View } from "./components/Hud.tsx";
import { Inbox } from "./components/Inbox.tsx";
import { NotesView } from "./components/NotesView.tsx";
import { PolicyDrawer } from "./components/PolicyDrawer.tsx";
import { OfficeFloor } from "./components/office/OfficeFloor.tsx";
import { ProfileCard } from "./components/ProfileCard.tsx";
import { Roster } from "./components/Roster.tsx";
import { nameOf, openAssignmentCount } from "./lib/assignments.ts";
import { chatPartner, chatScope, shownConversation } from "./lib/chat.ts";
import { openCount } from "./lib/inbox.ts";
import { resolveWikilink } from "./lib/notes.ts";
import { pendingPolicy } from "./lib/policy.ts";
import { dashboardsOf, viewsByMessage } from "./lib/views.ts";
import { rosterOrder } from "./state.ts";
import { useOffice } from "./useOffice.ts";

type Theme = "dark" | "light";
type Drawer = "chat" | "activity" | "assignments" | "policy" | null;

export function App() {
  const { state, commands, models } = useOffice();
  const now = useNow(1000);
  // The hiring card and the profile card name models, so ask for the list once the session has its
  // token, with the first snapshot. The profile card asks again if this fails.
  const loaded = state.loaded;
  useEffect(() => {
    if (loaded) commands.loadModels().catch(() => undefined);
  }, [commands, loaded]);
  const [view, setView] = useState<View>("office");
  const [drawer, setDrawer] = useState<Drawer>(null);
  // The chat the drawer shows. Null shows the Chief of Staff's.
  const [chatId, setChatId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(() => window.innerWidth >= 1400);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [notesTab, setNotesTab] = useState<"note" | "graph">("note");
  const [inboxFocus, setInboxFocus] = useState<string | null>(null);
  // A message a dashboard's button puts in a chat box, for the operator to edit or send.
  const [prefill, setPrefill] = useState<{ conversationId: string; text: string; key: number } | null>(null);
  const [theme, setTheme] = useTheme();

  const roster = useMemo(() => rosterOrder(state.agents), [state.agents]);
  const chief = state.agents.find((agent) => agent.role === "chief_of_staff") ?? null;
  const chiefChat = chief ? (state.conversations.find((conversation) => conversation.agentId === chief.id) ?? null) : null;
  const chat = shownConversation(state.conversations, chief?.id ?? null, chatId);
  const lastSeen = useLastSeen(state.agents);
  const partner = chat ? chatPartner(chat, state.agents, lastSeen) : null;
  const chatMessages = chat ? (state.messages[chat.id] ?? []) : [];
  // Replies stream into whichever chat is open.
  const streaming = useMemo(() => Object.values(state.streaming).filter((reply) => reply.conversationId === chat?.id), [state.streaming, chat?.id]);
  const chiefOpen = drawer === "chat" && chat !== null && chat.id === chiefChat?.id;
  // The unread badge counts the Chief of Staff's chat, where briefings and proposals arrive.
  const unread = useUnread(chiefChat?.id ?? null, chiefChat ? (state.messages[chiefChat.id] ?? []) : [], chiefOpen);
  const inbox = useMemo(() => openCount(state.items), [state.items]);
  const openAssignments = useMemo(() => openAssignmentCount(state.assignments), [state.assignments]);
  const profile = state.agents.find((agent) => agent.id === profileId) ?? null;
  const messageViews = useMemo(() => viewsByMessage(state.views), [state.views]);
  const dashboards = useMemo(() => dashboardsOf(state.views), [state.views]);
  const viewActions = useMemo(() => ({ resolve: commands.resolve, dismiss: commands.dismiss }), [commands]);
  const clearPrefill = useCallback(() => setPrefill(null), []);

  // Workers who have left still have names: their assignments keep them.
  const agentName = useCallback(
    (agentId: string | null) => (agentId ? (nameOf(agentId, state.agents, state.assignments) ?? agentId) : "AiHub"),
    [state.agents, state.assignments],
  );

  const openNote = useCallback((path: string) => {
    setProfileId(null);
    setNotePath(path);
    setNotesTab("note");
    setView("notes");
  }, []);

  const openChiefChat = useCallback(() => {
    setChatId(null);
    setDrawer("chat");
  }, []);

  /** Opens the operator's chat with anyone on staff, starting it if there is none yet. */
  const openChatWith = useCallback(
    async (agentId: string) => {
      const conversation = state.conversations.find((candidate) => candidate.agentId === agentId) ?? (await commands.openChat(agentId));
      setChatId(conversation.id);
      setProfileId(null);
      setDrawer("chat");
      return conversation;
    },
    [state.conversations, commands],
  );

  /** Opens a chat with a message in the box, unsent: the author's, or the Chief of Staff's once the author has left. */
  const askStaff = useCallback(
    (agentId: string, text: string) => {
      const target = state.agents.some((agent) => agent.id === agentId) ? agentId : chief?.id;
      if (!target) return;
      openChatWith(target).then(
        (conversation) => setPrefill((current) => ({ conversationId: conversation.id, text, key: (current?.key ?? 0) + 1 })),
        () => undefined,
      );
    },
    [state.agents, chief?.id, openChatWith],
  );

  // Wikilinks in chat resolve as the staff member would: its folder, then Office, then anyone's.
  const chatLinkFrom = useMemo(() => ({ ownerId: partner?.agent.id ?? chief?.id ?? null }), [partner?.agent.id, chief?.id]);
  const resolveChatLink = useCallback(
    (target: string) => {
      const found = resolveWikilink(target, chatLinkFrom, state.notes);
      return { exists: found !== null, title: found?.path };
    },
    [chatLinkFrom, state.notes],
  );
  const openChatLink = useCallback(
    (target: string) => {
      const found = resolveWikilink(target, chatLinkFrom, state.notes);
      if (found) openNote(found.path);
    },
    [chatLinkFrom, state.notes, openNote],
  );

  // Escape closes the drawer. The profile dialog handles its own Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && drawer && !document.querySelector("dialog[open]")) setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (!state.loaded) {
    return (
      <div className="app app-loading">
        <main className="loading">
          {state.error ? (
            <div className="card notice-error" role="alert">
              <h2>Can't reach the office</h2>
              <p>{state.error}</p>
              <p className="muted">
                Trying again in a moment. Start the daemon with <code>npm run dev</code> if it isn't running.
              </p>
            </div>
          ) : (
            <div className="loading-door" role="status">
              <span className="loading-dot" />
              <p className="muted">Unlocking the office…</p>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className={`app${rosterOpen ? " with-roster" : ""}${drawer ? " with-drawer" : ""}`}>
      <Hud
        view={view}
        onView={(next) => {
          setView(next);
          if (next !== "inbox") setInboxFocus(null);
        }}
        office={state.office}
        runtime={state.runtime}
        connection={state.connection}
        error={state.error}
        sources={state.connections}
        inbox={inbox}
        unread={unread}
        assignments={openAssignments}
        assignmentsOpen={drawer === "assignments"}
        policyPending={pendingPolicy(state.policies) !== null}
        policyOpen={drawer === "policy"}
        onTogglePolicy={() => setDrawer((current) => (current === "policy" ? null : "policy"))}
        chatOpen={chiefOpen}
        rosterOpen={rosterOpen}
        theme={theme}
        now={now}
        onToggleAssignments={() => setDrawer((current) => (current === "assignments" ? null : "assignments"))}
        // The HUD's chat is the Chief of Staff's; with another chat open, it switches to it.
        onToggleChat={() => (chiefOpen ? setDrawer(null) : openChiefChat())}
        onToggleRoster={() => setRosterOpen((open) => !open)}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
      {state.error && (
        <p className="banner" role="status">
          {/[.!?…]$/.test(state.error) ? state.error : `${state.error}.`} Trying again…
        </p>
      )}

      <div className="stage">
        {rosterOpen && (
          <Roster entries={roster} runs={state.runs} now={now} selectedId={profileId} onSelect={setProfileId} onClose={() => setRosterOpen(false)} />
        )}
        <main className="main" id="main">
          {view === "office" && (
            <OfficeFloor
              state={state}
              now={now}
              onSelectAgent={setProfileId}
              onOpenChat={openChiefChat}
              onOpenInbox={(responsibilityId) => {
                setInboxFocus(responsibilityId ?? null);
                setView("inbox");
              }}
            />
          )}
          {view === "inbox" && (
            <Inbox
              items={state.items}
              responsibilities={state.responsibilities}
              agents={state.agents}
              now={now}
              focus={inboxFocus}
              onDismiss={commands.dismiss}
              onResolve={commands.resolve}
              onSelectAgent={setProfileId}
            />
          )}
          {view === "dashboards" && (
            <Dashboards
              dashboards={dashboards}
              items={state.items}
              now={now}
              nameOf={agentName}
              onAsk={askStaff}
              onResolve={commands.resolve}
              onDismiss={commands.dismiss}
              onData={commands.viewData}
              onRemove={commands.removeDashboard}
            />
          )}
          {view === "notes" && (
            <NotesView
              notes={state.notes}
              agents={roster.map((entry) => entry.agent)}
              openPath={notePath}
              tab={notesTab}
              now={now}
              onOpen={setNotePath}
              onTab={setNotesTab}
              onSave={commands.saveNote}
              onSelectAgent={setProfileId}
            />
          )}
        </main>

        {drawer === "chat" &&
          (chat && partner ? (
            <ChatDrawer
              key={chat.id}
              agent={partner.agent}
              present={partner.present}
              conversation={chat}
              messages={chatMessages}
              runs={state.runs}
              streaming={streaming}
              proposals={state.proposals}
              policies={state.policies}
              models={models}
              readers={state.readers}
              scope={chatScope(partner.agent)}
              back={chief && chiefChat && chat.id !== chiefChat.id ? { name: chief.name, unread } : null}
              onBack={openChiefChat}
              onSend={(text) => commands.send(chat.id, text)}
              onPreview={commands.preview}
              onApprove={commands.approve}
              onDecline={commands.decline}
              onApprovePolicy={commands.approvePolicy}
              onDeclinePolicy={commands.declinePolicy}
              onClose={() => setDrawer(null)}
              onOpenProfile={() => setProfileId(partner.agent.id)}
              resolveLink={resolveChatLink}
              onOpenLink={openChatLink}
              views={messageViews}
              items={state.items}
              viewActions={viewActions}
              nameOf={agentName}
              prefill={prefill && prefill.conversationId === chat.id ? prefill : null}
              onPrefilled={clearPrefill}
            />
          ) : (
            <aside className="drawer chat-drawer" aria-label="Chat">
              <p className="empty">Nobody is on staff to chat with yet.</p>
            </aside>
          ))}
        {drawer === "activity" && <ActivityLog entries={state.activity} agentName={agentName} onClose={() => setDrawer(null)} />}
        {drawer === "policy" && (
          <PolicyDrawer policies={state.policies} agentName={agentName} onSave={commands.savePolicy} onOpenProposal={openChiefChat} onClose={() => setDrawer(null)} />
        )}
        {drawer === "assignments" && (
          <AssignmentsDrawer assignments={state.assignments} agents={state.agents} now={now} onSelectAgent={setProfileId} onClose={() => setDrawer(null)} />
        )}
      </div>

      <ActivityTicker entries={state.activity} agentName={agentName} onOpenLog={() => setDrawer("activity")} />
      <Toasts entries={state.activity} loaded={state.loaded} agentName={agentName} />

      {profile && (
        <ProfileCard
          agent={profile}
          agents={state.agents}
          responsibilities={state.responsibilities}
          routines={state.routines}
          connections={state.connections}
          runs={state.runs}
          activity={state.activity}
          assignments={state.assignments}
          notes={state.notes}
          readers={state.readers}
          now={now}
          onClose={() => setProfileId(null)}
          onSelectAgent={setProfileId}
          onOpenChat={() => openChatWith(profile.id).then(() => undefined)}
          onOpenNote={openNote}
          onUpdate={(changes) => commands.updateAgent(profile.id, changes)}
          onSetWeb={(web) => commands.setWeb(profile.id, web)}
          models={models}
          onLoadModels={commands.loadModels}
          onSetModel={(choice) => commands.setModel(profile.id, choice)}
          onRunRoutine={commands.runRoutine}
          onSetWeekends={commands.setWeekends}
        />
      )}
    </div>
  );
}

/** The current time, updated every `intervalMs`. Drives the clock, the lighting, and short-lived badges. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const THEME_KEY = "aihub.theme";

/** Dark first; the light theme is a toggle away and remembered in this browser. */
function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be unavailable; the theme still applies for this visit.
    }
  }, [theme]);
  return [theme, setTheme];
}

/**
 * Every staff member as last seen on the roster. Someone who leaves drops off it, but a chat open
 * with them still shows who they were.
 */
function useLastSeen(agents: Agent[]): ReadonlyMap<string, Agent> {
  const seen = useRef(new Map<string, Agent>());
  for (const agent of agents) seen.current.set(agent.id, agent);
  return seen.current;
}

/** Agent messages the operator hasn't seen with the chat open, remembered in this browser. */
function useUnread(conversationId: string | null, messages: Array<{ id: number; author: string }>, open: boolean): number {
  const key = conversationId ? `aihub.seen.${conversationId}` : null;
  const [seen, setSeen] = useState<number>(() => readSeen(key));
  useEffect(() => setSeen(readSeen(key)), [key]);
  const newest = messages.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!open || !key || newest <= seen) return;
    setSeen(newest);
    try {
      localStorage.setItem(key, String(newest));
    } catch {
      // Unread counts reset with storage unavailable; nothing else depends on them.
    }
  }, [open, key, newest, seen]);
  if (open) return 0;
  return messages.filter((message) => message.author === "agent" && message.id > seen).length;
}

function readSeen(key: string | null): number {
  if (!key) return 0;
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}
