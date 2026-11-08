import type { ReactNode } from "react";
import type { Agent, ChatMessage, Conversation } from "@aihub/shared";
import { lookFor } from "../lib/avatar.ts";
import { chatName, chatsOf } from "../lib/chat.ts";
import { ROLE_LABELS } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";

// Every chat full screen: the operator's chats down the side, each staff member's general chat and
// topics together, and the open one beside them at a width that reads well.

interface ChatsPageProps {
  /** Staff in roster order. */
  staff: Agent[];
  /** Staff who have left, as last seen, for the chats they left behind. */
  departed: Agent[];
  conversations: Conversation[];
  messages: Record<string, ChatMessage[]>;
  unread: ReadonlyMap<string, number>;
  selectedId: string | null;
  onSelect(conversationId: string): void;
  /** Opens a staff member's general chat, starting it if there is none yet. */
  onOpenGeneral(agentId: string): void;
  onNewTopic(agentId: string): void;
  /** The open chat. */
  children: ReactNode;
}

export function ChatsPage(props: ChatsPageProps) {
  const { conversations, messages, unread, selectedId } = props;
  const group = (agent: Agent, present: boolean) => {
    const chats = chatsOf(agent.id, conversations, messages);
    if (!present && chats.length === 0) return null;
    const general = chats.find((chat) => !chat.topic);
    return (
      <li key={agent.id} className="chats-person">
        <div className="chats-person-head">
          <Portrait look={lookFor(agent.avatar)} size={28} animated={false} />
          <span className="chats-person-name">
            <span className="agent-name">{agent.name}</span>
            <span className="agent-role">{agent.title || ROLE_LABELS[agent.role]}</span>
          </span>
          {present && (
            <button type="button" className="icon-button small" onClick={() => props.onNewTopic(agent.id)} title={`Start a topic with ${agent.name}`}>
              <Icon name="plus" size={14} />
              <span className="visually-hidden">New topic with {agent.name}</span>
            </button>
          )}
        </div>
        <ul className="chats-topics">
          {(general || present) && (
            <ChatLink
              name="General"
              current={general !== undefined && general.id === selectedId}
              unread={general ? (unread.get(general.id) ?? 0) : 0}
              onClick={() => (general ? props.onSelect(general.id) : props.onOpenGeneral(agent.id))}
            />
          )}
          {chats
            .filter((chat) => chat.topic)
            .map((chat) => (
              <ChatLink key={chat.id} name={chatName(chat)} current={chat.id === selectedId} unread={unread.get(chat.id) ?? 0} onClick={() => props.onSelect(chat.id)} />
            ))}
        </ul>
      </li>
    );
  };

  const departed = props.departed.map((agent) => group(agent, false)).filter(Boolean);
  return (
    <div className="chats-view">
      <nav className="chats-list" aria-labelledby="chats-title">
        <h1 id="chats-title" className="chats-heading">
          Chats
        </h1>
        <ul className="chats-people">{props.staff.map((agent) => group(agent, true))}</ul>
        {departed.length > 0 && (
          <>
            <h2 className="eyebrow chats-departed">Left the office</h2>
            <ul className="chats-people">{departed}</ul>
          </>
        )}
      </nav>
      <div className="chats-open">{props.children}</div>
    </div>
  );
}

function ChatLink({ name, current, unread, onClick }: { name: string; current: boolean; unread: number; onClick(): void }) {
  return (
    <li>
      <button type="button" className="chats-link" aria-current={current ? "page" : undefined} onClick={onClick}>
        <span className="chats-link-name">{name}</span>
        {unread > 0 && (
          <span className="count-badge tone-accent">
            <span aria-hidden="true">{unread}</span>
            <span className="visually-hidden">, {unread} unread</span>
          </span>
        )}
      </button>
    </li>
  );
}
