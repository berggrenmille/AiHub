import { useCallback, useMemo, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { Chat } from "./components/Chat.tsx";
import { Header } from "./components/Header.tsx";
import { Roster } from "./components/Roster.tsx";
import { rosterOrder } from "./state.ts";
import { useOffice } from "./useOffice.ts";

export function App() {
  const { state, send } = useOffice();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const roster = useMemo(() => rosterOrder(state.agents), [state.agents]);
  const selected =
    state.agents.find((agent) => agent.id === selectedId) ??
    state.agents.find((agent) => agent.role === "chief_of_staff") ??
    roster[0]?.agent;
  const conversation = selected && state.conversations.find((candidate) => candidate.agentId === selected.id);
  const streaming = useMemo(
    () => Object.values(state.streaming).filter((reply) => reply.conversationId === conversation?.id),
    [state.streaming, conversation?.id],
  );

  const agentName = useCallback(
    (agentId: string | null) => (agentId ? (state.agents.find((agent) => agent.id === agentId)?.name ?? agentId) : "AiHub"),
    [state.agents],
  );

  return (
    <div className="app">
      <Header runtime={state.runtime} connection={state.connection} error={state.error} />
      {state.loaded && state.error && (
        <p className="banner" role="status">
          {/[.!?…]$/.test(state.error) ? state.error : `${state.error}.`} Trying again…
        </p>
      )}
      {!state.loaded ? (
        <main className="loading">
          {state.error ? (
            <div className="notice notice-error" role="alert">
              <h2>Can't connect to AiHub</h2>
              <p>{state.error}</p>
              <p className="muted">Trying again in a moment. Start the daemon with <code>npm run dev</code> if it isn't running.</p>
            </div>
          ) : (
            <p className="muted">Connecting to the daemon…</p>
          )}
        </main>
      ) : (
        <main className="layout">
          <Roster entries={roster} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
          {selected && conversation ? (
            <Chat
              key={conversation.id}
              agent={selected}
              conversation={conversation}
              messages={state.messages[conversation.id] ?? []}
              runs={state.runs}
              streaming={streaming}
              onSend={(text) => send(conversation.id, text)}
            />
          ) : (
            <section className="panel chat" aria-label="Chat">
              <p className="empty">{selected ? `${selected.name} has no chat yet.` : "Nobody is on staff yet."}</p>
            </section>
          )}
          <ActivityFeed entries={state.activity} agentName={agentName} />
        </main>
      )}
    </div>
  );
}
