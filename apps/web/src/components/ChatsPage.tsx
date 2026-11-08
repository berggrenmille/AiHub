import { useState, type ReactNode } from "react";
import type { Agent, ChatMessage, Conversation, Meeting } from "@aihub/shared";
import { lookFor } from "../lib/avatar.ts";
import { chatName, chatsOf } from "../lib/chat.ts";
import { MEETING_STATUS_LABELS, meetingStatus } from "../lib/meetings.ts";
import { ROLE_LABELS } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";

// Every chat full screen: the operator's chats down the side, meetings first, then each staff
// member's general chat and topics together, and the open one beside them at a width that reads well.

/** Ended meetings listed until the operator asks for more. */
const ENDED_SHOWN = 3;

interface ChatsPageProps {
  /** Staff in roster order. */
  staff: Agent[];
  /** Staff who have left, as last seen, for the chats they left behind. */
  departed: Agent[];
  conversations: Conversation[];
  /** Newest first. */
  meetings: Meeting[];
  messages: Record<string, ChatMessage[]>;
  unread: ReadonlyMap<string, number>;
  selectedId: string | null;
  onSelect(conversationId: string): void;
  /** Opens a staff member's general chat, starting it if there is none yet. */
  onOpenGeneral(agentId: string): void;
  onNewTopic(agentId: string): void;
  /** The form for calling a meeting is open in place of a chat. */
  calling: boolean;
  onCallMeeting(): void;
  /** The open chat. */
  children: ReactNode;
}

export function ChatsPage(props: ChatsPageProps) {
  const { conversations, messages, unread, selectedId } = props;
  const group = (agent: Agent, present: boolean) => {
    const chats = chatsOf(agent.id, conversations, messages);
    if (!present && chats.length === 0) return null;
    const general = chats.find((chat) => chat.kind === "general");
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
            .filter((chat) => chat.kind === "topic")
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
        <MeetingList meetings={props.meetings} unread={unread} selectedId={props.calling ? null : selectedId} calling={props.calling} onSelect={props.onSelect} onCall={props.onCallMeeting} />
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

interface MeetingListProps {
  meetings: Meeting[];
  unread: ReadonlyMap<string, number>;
  selectedId: string | null;
  calling: boolean;
  onSelect(meetingId: string): void;
  onCall(): void;
}

/** Meetings under way or waiting for the operator, then the most recent ended ones. */
function MeetingList({ meetings, unread, selectedId, calling, onSelect, onCall }: MeetingListProps) {
  const [all, setAll] = useState(false);
  const open = meetings.filter((meeting) => meeting.state !== "closed");
  const ended = meetings.filter((meeting) => meeting.state === "closed");
  const shown = [...open, ...(all ? ended : ended.slice(0, ENDED_SHOWN))];
  return (
    <section className="chats-meetings" aria-labelledby="chats-meetings-title">
      <div className="chats-person-head">
        <span className="chats-meetings-mark" aria-hidden="true">
          <Icon name="team" size={16} />
        </span>
        <h2 id="chats-meetings-title" className="chats-person-name">
          <span className="agent-name">Meetings</span>
        </h2>
        <button type="button" className="icon-button small" aria-pressed={calling} onClick={onCall} title="Call a meeting">
          <Icon name="plus" size={14} />
          <span className="visually-hidden">Call a meeting</span>
        </button>
      </div>
      <ul className="chats-topics">
        {shown.length === 0 && (
          <li>
            <button type="button" className="chats-link" aria-current={calling ? "page" : undefined} onClick={onCall}>
              <span className="chats-link-name">Call a meeting</span>
            </button>
          </li>
        )}
        {shown.map((meeting) => {
          const status = meetingStatus(meeting);
          return (
            <ChatLink key={meeting.id} name={meeting.title} current={meeting.id === selectedId} unread={unread.get(meeting.id) ?? 0} onClick={() => onSelect(meeting.id)}>
              {status !== "ended" && <span className={`pill small meeting-status-${status}`}>{MEETING_STATUS_LABELS[status]}</span>}
            </ChatLink>
          );
        })}
        {!all && ended.length > ENDED_SHOWN && (
          <li>
            <button type="button" className="chats-link chats-more" onClick={() => setAll(true)}>
              {ended.length - ENDED_SHOWN} earlier meetings
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

function ChatLink({ name, current, unread, onClick, children }: { name: string; current: boolean; unread: number; onClick(): void; children?: ReactNode }) {
  return (
    <li>
      <button type="button" className="chats-link" aria-current={current ? "page" : undefined} onClick={onClick}>
        <span className="chats-link-name">{name}</span>
        {children}
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
