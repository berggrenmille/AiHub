import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@aihub/shared";
import { ActivityLog, ActivityTicker, Toasts } from "./components/Activity.tsx";
import { AssignmentsDrawer } from "./components/Assignments.tsx";
import { AccessPanel } from "./components/AccessPanel.tsx";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { ChatsPage } from "./components/ChatsPage.tsx";
import { Dashboards } from "./components/Dashboards.tsx";
import { Inbox } from "./components/Inbox.tsx";
import { NotesView } from "./components/NotesView.tsx";
import { PolicyDrawer } from "./components/PolicyDrawer.tsx";
import { OfficeFloor } from "./components/office/OfficeFloor.tsx";
import { ProfileCard } from "./components/ProfileCard.tsx";
import { Rail, type Page, type Theme } from "./components/Rail.tsx";
import { Roster } from "./components/Roster.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { nameOf, openAssignmentCount } from "./lib/assignments.ts";
import { chatPartner, chatScope, chatsOf, shownConversation } from "./lib/chat.ts";
import { openCount } from "./lib/inbox.ts";
import { unsafeRows } from "./lib/access.ts";
import { resolveWikilink } from "./lib/notes.ts";
import { pendingPolicy } from "./lib/policy.ts";
import type { ToastContext } from "./lib/toasts.ts";
import { dashboardsOf, viewsByMessage } from "./lib/views.ts";
import { isActive, rosterOrder } from "./state.ts";
import { useOffice } from "./useOffice.ts";
import { useUnread } from "./useUnread.ts";

type Drawer = "chat" | "activity" | "assignments" | "policy" | "access" | null;

export function App() {
  const { state, commands, models } = useOffice();
  const now = useNow(1000);
  // The hiring card and the profile card name models, so ask for the list once the session has its
  // token, with the first snapshot. The profile card asks again if this fails.
  const loaded = state.loaded;
  useEffect(() => {
    if (loaded) commands.loadModels().catch(() => undefined);
  }, [commands, loaded]);
  const [page, setPage] = useState<Page>("office");
  const [drawer, setDrawer] = useState<Drawer>(null);
  // The chat the drawer or the Chats page shows. Null shows the Chief of Staff's general chat.
  const [chatId, setChatId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(() => window.innerWidth >= 1400);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [notesTab, setNotesTab] = useState<"note" | "graph">("note");
  const [inboxFocus, setInboxFocus] = useState<string | null>(null);
  // The staff member the Access panel shows alone, from a profile card's link.
  const [accessFocus, setAccessFocus] = useState<string | null>(null);
  // A message a dashboard's button puts in a chat box, for the operator to edit or send.
  const [prefill, setPrefill] = useState<{ conversationId: string; text: string; key: number } | null>(null);
  const [theme, setTheme] = useTheme();

  const roster = useMemo(() => rosterOrder(state.agents), [state.agents]);
  const chief = state.agents.find((agent) => agent.role === "chief_of_staff") ?? null;
  const chiefChat = chief ? (state.conversations.find((conversation) => conversation.agentId === chief.id && !conversation.topic) ?? null) : null;
  const chat = shownConversation(state.conversations, chief?.id ?? null, chatId);
  const lastSeen = useLastSeen(state.agents);
  const partner = chat ? chatPartner(chat, state.agents, lastSeen) : null;
  const chatMessages = chat ? (state.messages[chat.id] ?? []) : [];
  // Replies stream into whichever chat is open.
  const streaming = useMemo(() => Object.values(state.streaming).filter((reply) => reply.conversationId === chat?.id), [state.streaming, chat?.id]);
  const onChatsPage = page === "chats";
  const drawerChatOpen = drawer === "chat" && !onChatsPage;
  const visibleChat = (drawerChatOpen || onChatsPage) && chat ? chat : null;
  const unread = useUnread(state.conversations, state.messages, visibleChat?.id ?? null);
  const totalUnread = useMemo(() => [...unread.values()].reduce((sum, count) => sum + count, 0), [unread]);
  // Briefings, proposals and notices arrive in the Chief of Staff's chats.
  const chiefUnread = useMemo(
    () => state.conversations.filter((conversation) => conversation.agentId === chief?.id).reduce((sum, conversation) => sum + (unread.get(conversation.id) ?? 0), 0),
    [state.conversations, chief?.id, unread],
  );
  const chiefOpen = drawerChatOpen && chat !== null && chat.agentId === chief?.id;
  const partnerChats = useMemo(() => (partner ? chatsOf(partner.agent.id, state.conversations, state.messages) : []), [partner, state.conversations, state.messages]);
  const inbox = useMemo(() => openCount(state.items), [state.items]);
  const openAssignments = useMemo(() => openAssignmentCount(state.assignments), [state.assignments]);
  const profile = state.agents.find((agent) => agent.id === profileId) ?? null;
  // A staff review in progress, from its run.
  const reviewRunning = Object.values(state.runs).some((run) => run.kind === "review" && isActive(run));
  const messageViews = useMemo(() => viewsByMessage(state.views), [state.views]);
  const dashboards = useMemo(() => dashboardsOf(state.views), [state.views]);
  const viewActions = useMemo(() => ({ resolve: commands.resolve, dismiss: commands.dismiss }), [commands]);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  const unsafeCount = useMemo(() => unsafeRows(state.services, state.serviceGrants, state.agents).length, [state.services, state.serviceGrants, state.agents]);
  const serviceActions = useMemo(
    () => ({ approve: commands.approveService, decline: commands.declineService, signIn: commands.signInService, refresh: commands.refreshService }),
    [commands],
  );
  const toastContext = useMemo<ToastContext>(
    () => ({ runKind: (runId) => state.runs[runId]?.kind, cardsInView: visibleChat !== null && visibleChat.agentId === chief?.id }),
    [state.runs, visibleChat, chief?.id],
  );
  const openAccess = useCallback((agentId: string | null) => {
    setAccessFocus(agentId);
    setProfileId(null);
    setDrawer("access");
  }, []);

  // Workers who have left still have names: their assignments keep them.
  const agentName = useCallback(
    (agentId: string | null) => (agentId ? (nameOf(agentId, state.agents, state.assignments) ?? agentId) : "AiHub"),
    [state.agents, state.assignments],
  );

  const goTo = useCallback((next: Page) => {
    setPage(next);
    if (next !== "inbox") setInboxFocus(null);
    // The Chats page shows the chat the drawer had; one place is enough.
    if (next === "chats") setDrawer((current) => (current === "chat" ? null : current));
  }, []);

  const openNote = useCallback(
    (path: string) => {
      setProfileId(null);
      setNotePath(path);
      setNotesTab("note");
      goTo("notes");
    },
    [goTo],
  );

  /** Shows a chat where chats are on screen: the Chats page if it is open, else the drawer. */
  const showChat = useCallback(
    (conversationId: string | null) => {
      setChatId(conversationId);
      setProfileId(null);
      if (!onChatsPage) setDrawer("chat");
    },
    [onChatsPage],
  );

  const openChiefChat = useCallback(() => showChat(null), [showChat]);

  /** Opens the operator's general chat with anyone on staff, starting it if there is none yet. */
  const openChatWith = useCallback(
    async (agentId: string) => {
      const conversation =
        state.conversations.find((candidate) => candidate.agentId === agentId && !candidate.topic) ?? (await commands.openChat(agentId));
      showChat(conversation.id);
      return conversation;
    },
    [state.conversations, commands, showChat],
  );

  const startTopic = useCallback(
    async (agentId: string) => {
      const conversation = await commands.startTopic(agentId);
      showChat(conversation.id);
    },
    [commands, showChat],
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

  const togglePanel = (panel: Exclude<Drawer, "chat" | null>) => setDrawer((current) => (current === panel ? null : panel));
  const chatPanel = (variant: "drawer" | "page") =>
    chat && partner ? (
      <ChatPanel
        key={chat.id}
        variant={variant}
        agent={partner.agent}
        present={partner.present}
        conversation={chat}
        chats={partnerChats}
        unread={unread}
        messages={chatMessages}
        runs={state.runs}
        streaming={streaming}
        proposals={state.proposals}
        policies={state.policies}
        staffChanges={state.staffChanges}
        models={models}
        readers={state.readers}
        services={state.services}
        serviceActions={serviceActions}
        scope={chatScope(partner.agent)}
        back={chief && chiefChat && chat.agentId !== chief.id ? { name: chief.name, unread: chiefUnread } : null}
        onBack={openChiefChat}
        onSelectChat={showChat}
        onNewTopic={() => startTopic(partner.agent.id)}
        onRename={(title) => commands.renameTopic(chat.id, title)}
        onSend={(text) => commands.send(chat.id, text)}
        onPreview={commands.preview}
        onApprove={commands.approve}
        onDecline={commands.decline}
        onApprovePolicy={commands.approvePolicy}
        onDeclinePolicy={commands.declinePolicy}
        onApproveStaffChange={commands.approveStaffChange}
        onDeclineStaffChange={commands.declineStaffChange}
        onExpand={() => goTo("chats")}
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
      <aside className={variant === "page" ? "chat-page" : "drawer chat-drawer"} aria-label="Chat">
        <p className="empty">Nobody is on staff to chat with yet.</p>
      </aside>
    );

  // Staff who have left keep their chats, readable, under their names as last known.
  const departed = [...new Set(state.conversations.map((conversation) => conversation.agentId))]
    .filter((agentId) => !state.agents.some((agent) => agent.id === agentId))
    .map((agentId) => chatPartner(state.conversations.find((conversation) => conversation.agentId === agentId && !conversation.topic) ?? state.conversations.find((conversation) => conversation.agentId === agentId)!, state.agents, lastSeen).agent);

  return (
    <div className={`app${drawer ? " with-drawer" : ""}`}>
      <Rail
        page={page}
        onPage={goTo}
        inbox={inbox}
        unread={totalUnread}
        assignments={openAssignments}
        assignmentsOpen={drawer === "assignments"}
        onToggleAssignments={() => togglePanel("assignments")}
        unsafeCount={unsafeCount}
        accessOpen={drawer === "access"}
        onToggleAccess={() => (drawer === "access" ? setDrawer(null) : openAccess(null))}
        policyPending={pendingPolicy(state.policies) !== null}
        policyOpen={drawer === "policy"}
        onTogglePolicy={() => togglePanel("policy")}
        theme={theme}
        onTheme={setTheme}
      />
      <div className="app-column">
        <TopBar
          office={state.office}
          floor={page === "office" ? { rosterOpen, onToggleRoster: () => setRosterOpen((open) => !open) } : null}
          runtime={state.runtime}
          connection={state.connection}
          error={state.error}
          sources={state.connections}
          now={now}
          chat={{
            name: chief?.name ?? "the Chief of Staff",
            open: chiefOpen,
            unread: chiefUnread,
            // On the Chats page the chat is already there: this picks the Chief of Staff's.
            onToggle: () => (onChatsPage ? setChatId(null) : chiefOpen ? setDrawer(null) : openChiefChat()),
          }}
        />
        {state.error && (
          <p className="banner" role="status">
            {/[.!?…]$/.test(state.error) ? state.error : `${state.error}.`} Trying again…
          </p>
        )}

        <div className="stage">
          {page === "office" && rosterOpen && (
            <Roster entries={roster} runs={state.runs} now={now} selectedId={profileId} onSelect={setProfileId} onClose={() => setRosterOpen(false)} />
          )}
          <main className="main" id="main">
            {page === "office" && (
              <OfficeFloor
                state={state}
                now={now}
                onSelectAgent={setProfileId}
                onOpenChat={openChiefChat}
                onOpenInbox={(responsibilityId) => {
                  goTo("inbox");
                  setInboxFocus(responsibilityId ?? null);
                }}
              />
            )}
            {page === "inbox" && (
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
            {page === "chats" && (
              <ChatsPage
                staff={roster.map((entry) => entry.agent)}
                departed={departed}
                conversations={state.conversations}
                messages={state.messages}
                unread={unread}
                selectedId={chat?.id ?? null}
                onSelect={setChatId}
                onOpenGeneral={(agentId) => void openChatWith(agentId).catch(() => undefined)}
                onNewTopic={(agentId) => void startTopic(agentId).catch(() => undefined)}
              >
                {chatPanel("page")}
              </ChatsPage>
            )}
            {page === "dashboards" && (
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
            {page === "notes" && (
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

          {drawerChatOpen && chatPanel("drawer")}
          {drawer === "activity" && <ActivityLog entries={state.activity} agentName={agentName} onClose={() => setDrawer(null)} />}
          {drawer === "policy" && (
            <PolicyDrawer policies={state.policies} agentName={agentName} onSave={commands.savePolicy} onOpenProposal={openChiefChat} onClose={() => setDrawer(null)} />
          )}
          {drawer === "access" && (
            <AccessPanel
              services={state.services}
              grants={state.serviceGrants}
              connections={state.connections}
              readers={state.readers}
              agents={state.agents}
              focusId={accessFocus}
              onFocus={setAccessFocus}
              agentName={agentName}
              onSelectAgent={setProfileId}
              onRevokeGrant={commands.revokeServiceGrant}
              onRevokeSource={commands.revokeSource}
              onSetWeb={commands.setWeb}
              onSignIn={commands.signInService}
              onRefresh={commands.refreshService}
              onRemove={commands.removeService}
              onClose={() => setDrawer(null)}
            />
          )}
          {drawer === "assignments" && (
            <AssignmentsDrawer assignments={state.assignments} agents={state.agents} now={now} onSelectAgent={setProfileId} onClose={() => setDrawer(null)} />
          )}
        </div>

        <ActivityTicker entries={state.activity} agentName={agentName} onOpenLog={() => setDrawer("activity")} />
      </div>
      <Toasts entries={state.activity} loaded={state.loaded} agentName={agentName} context={toastContext} onOpenLog={() => setDrawer("activity")} />

      {profile && (
        <ProfileCard
          agent={profile}
          agents={state.agents}
          responsibilities={state.responsibilities}
          routines={state.routines}
          connections={state.connections}
          services={state.services}
          serviceGrants={state.serviceGrants}
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
          onOpenAccess={() => openAccess(profile.id)}
          models={models}
          onLoadModels={commands.loadModels}
          onSetModel={(choice) => commands.setModel(profile.id, choice)}
          onRunRoutine={commands.runRoutine}
          onSetWeekends={commands.setWeekends}
          staffReview={
            profile.role === "chief_of_staff"
              ? { lastAt: state.office?.staffReviewAt ?? null, running: reviewRunning, onRun: commands.reviewStaff }
              : null
          }
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

/** Dark first; the light theme is a setting away and remembered in this browser. */
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
