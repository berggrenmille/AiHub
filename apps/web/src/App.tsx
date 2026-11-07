import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityLog, ActivityTicker, Toasts } from "./components/Activity.tsx";
import { AssignmentsDrawer } from "./components/Assignments.tsx";
import { ChatDrawer } from "./components/ChatDrawer.tsx";
import { Hud, type View } from "./components/Hud.tsx";
import { Inbox } from "./components/Inbox.tsx";
import { NotesView } from "./components/NotesView.tsx";
import { OfficeFloor } from "./components/office/OfficeFloor.tsx";
import { ProfileCard } from "./components/ProfileCard.tsx";
import { Roster } from "./components/Roster.tsx";
import { nameOf, openAssignmentCount } from "./lib/assignments.ts";
import { openCount } from "./lib/inbox.ts";
import { resolveWikilink } from "./lib/notes.ts";
import { rosterOrder } from "./state.ts";
import { useOffice } from "./useOffice.ts";

type Theme = "dark" | "light";
type Drawer = "chat" | "activity" | "assignments" | null;

export function App() {
  const { state, commands } = useOffice();
  const now = useNow(1000);
  const [view, setView] = useState<View>("office");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(() => window.innerWidth >= 1400);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [notesTab, setNotesTab] = useState<"note" | "graph">("note");
  const [inboxFocus, setInboxFocus] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();

  const roster = useMemo(() => rosterOrder(state.agents), [state.agents]);
  const chief = state.agents.find((agent) => agent.role === "chief_of_staff") ?? null;
  const chiefChat = chief ? (state.conversations.find((conversation) => conversation.agentId === chief.id) ?? null) : null;
  const chatMessages = chiefChat ? (state.messages[chiefChat.id] ?? []) : [];
  const streaming = useMemo(
    () => Object.values(state.streaming).filter((reply) => reply.conversationId === chiefChat?.id),
    [state.streaming, chiefChat?.id],
  );
  const unread = useUnread(chiefChat?.id ?? null, chatMessages, drawer === "chat");
  const inbox = useMemo(() => openCount(state.items), [state.items]);
  const openAssignments = useMemo(() => openAssignmentCount(state.assignments), [state.assignments]);
  const profile = state.agents.find((agent) => agent.id === profileId) ?? null;

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

  // Wikilinks in chat resolve as the Chief of Staff would: its folder, then Office, then anyone's.
  const chatLinkFrom = useMemo(() => ({ ownerId: chief?.id ?? null }), [chief?.id]);
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
        chatOpen={drawer === "chat"}
        rosterOpen={rosterOpen}
        theme={theme}
        now={now}
        onToggleAssignments={() => setDrawer((current) => (current === "assignments" ? null : "assignments"))}
        onToggleChat={() => setDrawer((current) => (current === "chat" ? null : "chat"))}
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
              onOpenChat={() => setDrawer("chat")}
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
          (chief && chiefChat ? (
            <ChatDrawer
              key={chiefChat.id}
              agent={chief}
              conversation={chiefChat}
              messages={chatMessages}
              runs={state.runs}
              streaming={streaming}
              proposals={state.proposals}
              onSend={(text) => commands.send(chiefChat.id, text)}
              onApprove={commands.approve}
              onDecline={commands.decline}
              onClose={() => setDrawer(null)}
              onOpenProfile={() => setProfileId(chief.id)}
              resolveLink={resolveChatLink}
              onOpenLink={openChatLink}
            />
          ) : (
            <aside className="drawer chat-drawer" aria-label="Chat">
              <p className="empty">Nobody is on staff to chat with yet.</p>
            </aside>
          ))}
        {drawer === "activity" && <ActivityLog entries={state.activity} agentName={agentName} onClose={() => setDrawer(null)} />}
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
          hasChat={state.conversations.some((conversation) => conversation.agentId === profile.id)}
          now={now}
          onClose={() => setProfileId(null)}
          onSelectAgent={setProfileId}
          onOpenChat={() => {
            setProfileId(null);
            setDrawer("chat");
          }}
          onOpenNote={openNote}
          onUpdate={(changes) => commands.updateAgent(profile.id, changes)}
          onRunRoutine={commands.runRoutine}
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
