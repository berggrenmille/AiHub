import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Agent, ChatMessage, Conversation, Item, Meeting, ModelOption, PolicyVersion, Proposal, Run, Service, SourcePreview, StaffChange, StaffReader, View } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { chatName } from "../lib/chat.ts";
import { MEETING_STATUS_LABELS, meetingStatus } from "../lib/meetings.ts";
import { formatClock, formatDateTime, formatLongDate, STATE_LABELS, toneOf } from "../format.ts";
import type { StreamingReply } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { Markdown, type WikilinkTarget } from "./Markdown.tsx";
import { Portrait } from "./office/Figure.tsx";
import { ProposalCard } from "./ProposalCard.tsx";
import { ServiceCard } from "./ServiceCard.tsx";
import { PolicyCard } from "./PolicyCard.tsx";
import { StaffChangeCard } from "./StaffChangeCard.tsx";
import { baseOf } from "../lib/policy.ts";
import { StateBadge } from "./StateBadge.tsx";
import { ViewFrame, type ViewActions } from "../views/LazyViewFrame.tsx";

/** The daemon rejects longer messages. */
const MAX_LENGTH = 20_000;
/** How close to the bottom, in pixels, still counts as following the conversation. */
const FOLLOW_SLACK = 48;

/** What a service card in the chat can ask of the daemon. */
export interface ServiceCardActions {
  approve(serviceId: string, unsafe: string[]): Promise<void>;
  decline(serviceId: string): Promise<void>;
  signIn(serviceId: string): Promise<string>;
  refresh(serviceId: string): Promise<void>;
}

interface ChatPanelProps {
  /** Beside the office in a drawer, or full screen on the Chats page. */
  variant: "drawer" | "page";
  agent: Agent;
  /** False once the staff member has left the office: the history stays, and the chat is closed. */
  present: boolean;
  conversation: Conversation;
  /** This staff member's chats, the general one first, for switching between topics in the drawer. */
  chats: Conversation[];
  /** Unread staff messages by chat. */
  unread: ReadonlyMap<string, number>;
  messages: ChatMessage[];
  runs: Record<string, Run>;
  streaming: StreamingReply[];
  /** For the cards that link to meetings the Chief of Staff called from the chat. */
  meetings: Meeting[];
  onOpenMeeting(meetingId: string): void;
  proposals: Proposal[];
  policies: PolicyVersion[];
  staffChanges: StaffChange[];
  /** The models Codex offers, for naming the one a proposal picks. */
  models: ModelOption[] | null;
  readers: StaffReader[];
  services: Service[];
  serviceActions: ServiceCardActions;
  /** What the staff member answers from, for anyone but the Chief of Staff. */
  scope: string | null;
  /** The way back to the Chief of Staff's chat, while someone else's is open in the drawer. */
  back: { name: string; unread: number } | null;
  onBack(): void;
  onSelectChat(conversationId: string): void;
  onNewTopic(): Promise<void>;
  onRename(title: string): Promise<void>;
  onSend(text: string): Promise<void>;
  onPreview(proposalId: string, sourcePath: string): Promise<SourcePreview>;
  onApprove(proposalId: string, sourcePath: string | undefined, unsafe: string[]): Promise<void>;
  onDecline(proposalId: string): Promise<void>;
  onApprovePolicy(policyId: number): Promise<void>;
  onDeclinePolicy(policyId: number): Promise<void>;
  onApproveStaffChange(changeId: number, unsafe: string[]): Promise<void>;
  onDeclineStaffChange(changeId: number): Promise<void>;
  /** Opens this chat full screen. Drawer only. */
  onExpand(): void;
  onClose(): void;
  onOpenProfile(): void;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
  /** Views staff showed under messages, by message ID. */
  views: Map<number, View[]>;
  /** For views' buttons that resolve or dismiss an item. */
  items: Item[];
  viewActions: Pick<ViewActions, "resolve" | "dismiss">;
  nameOf(agentId: string): string;
  /** A message a dashboard's button put in this chat's box. A new key puts it there again. */
  prefill: { text: string; key: number } | null;
  /** The prefill is in the box, so reopening the chat doesn't put it there again. */
  onPrefilled(): void;
}

export function ChatPanel(props: ChatPanelProps) {
  const { variant, agent, present, conversation, messages, runs, streaming, onSend, back } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Follow new messages unless the operator has scrolled up to read earlier ones.
  const following = useRef(true);
  const look = lookFor(agent.avatar);

  useEffect(() => inputRef.current?.focus(), []);

  // A view's button puts its message in the box for the operator to edit or send; it never sends.
  const ask = useCallback((text: string) => {
    setDraft(text);
    following.current = true;
    inputRef.current?.focus();
  }, []);
  const prefillKey = props.prefill?.key;
  const prefillText = props.prefill?.text;
  const { onPrefilled } = props;
  useEffect(() => {
    if (prefillKey === undefined || prefillText === undefined) return;
    ask(prefillText);
    onPrefilled();
  }, [prefillKey, prefillText, ask, onPrefilled]);

  const { viewActions, items, nameOf } = props;
  const actions = useMemo<ViewActions>(() => ({ ...viewActions, ask: present ? ask : undefined }), [viewActions, present, ask]);
  // A view under a reply carries its own heading. One in the briefing says whose section it is.
  const renderView = useCallback(
    (view: View, byline: string | null) => (
      <section key={view.id} className="message-view" aria-label={view.title}>
        {byline && (
          <p className="message-view-head">
            <span className="message-view-title">{view.title}</span>
            <span> · {byline}</span>
          </p>
        )}
        <ViewFrame view={view} items={items} actions={actions} />
      </section>
    ),
    [items, actions],
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, streaming, runs, props.proposals, props.policies, props.staffChanges]);

  // Stay at the bottom when the panel itself changes size, such as when the input grows.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (scroller) following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    setDraft("");
    following.current = true;
    onSend(text).catch((failure: unknown) => {
      setError(`Couldn't send the message: ${errorText(failure)}`);
      // Give the text back unless the operator has started typing something else.
      setDraft((current) => (current === "" ? text : current));
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const newTopic = () => {
    setError(null);
    props.onNewTopic().catch((failure: unknown) => setError(`Couldn't start a topic: ${errorText(failure)}`));
  };

  const inputId = `chat-input-${conversation.id}`;
  const hintId = `chat-hint-${conversation.id}`;
  const page = variant === "page";
  // The chief's chat is titled after the role, which the subtitle already says.
  const subtitle = [agent.title, conversation.kind === "topic" ? null : conversation.title].filter((part, index, parts) => part && part !== agent.name && parts.indexOf(part) === index).join(" · ");
  const Root = page ? "section" : "aside";
  const empty = conversation.kind === "topic"
    ? `A new topic with ${agent.name}, in a thread of its own. What you say first names it.`
    : present
      ? `No messages yet. Ask ${agent.name} anything.`
      : `You and ${agent.name} never talked.`;

  return (
    <Root
      className={`${page ? "chat-page" : "drawer chat-drawer"}${back && !page ? " chat-elsewhere" : ""}`}
      aria-label={`Chat with ${agent.name}${conversation.kind === "topic" ? `: ${conversation.title}` : ""}`}
      style={{ "--chat-accent": look.accent } as CSSProperties}
    >
      {back && !page && (
        <button type="button" className="chat-back" onClick={props.onBack}>
          <Icon name="back" size={16} />
          <span>Back to {back.name}'s chat</span>
          {back.unread > 0 && (
            <span className="count-badge" aria-label={`${back.unread} unread`}>
              {back.unread}
            </span>
          )}
        </button>
      )}
      <header className="drawer-head chat-head">
        {present ? (
          <button type="button" className="drawer-avatar" onClick={props.onOpenProfile} title={`Open ${agent.name}'s profile`}>
            <Portrait look={look} size={40} />
            <span className="visually-hidden">Open {agent.name}'s profile</span>
          </button>
        ) : (
          <span className="drawer-avatar">
            <Portrait look={look} size={40} animated={false} label={agent.name} />
          </span>
        )}
        {page ? (
          <PageTitle agent={agent} conversation={conversation} onRename={props.onRename} />
        ) : (
          <div className="drawer-title">
            <p className="eyebrow">Your chat with</p>
            <h2>{agent.name}</h2>
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
        )}
        {present ? <StateBadge state={agent.state} /> : <span className="pill">Left the office</span>}
        {page
          ? present && (
              <button type="button" className="hud-button" onClick={newTopic} title={`Start a topic with ${agent.name}, in a thread of its own`}>
                <Icon name="plus" size={16} />
                <span>New topic</span>
              </button>
            )
          : (
              <>
                <button type="button" className="icon-button" onClick={props.onExpand} title="Open full screen">
                  <Icon name="expand" />
                  <span className="visually-hidden">Open full screen</span>
                </button>
                <button type="button" className="icon-button" onClick={props.onClose} title="Close the chat">
                  <Icon name="close" />
                  <span className="visually-hidden">Close the chat</span>
                </button>
              </>
            )}
      </header>
      {!page && (props.chats.length > 1 || present) && (
        <div className="chat-topics">
          <label className="visually-hidden" htmlFor={`chat-topic-${conversation.id}`}>
            Topic
          </label>
          <select id={`chat-topic-${conversation.id}`} value={conversation.id} onChange={(event) => props.onSelectChat(event.target.value)}>
            {props.chats.map((chat) => {
              const unread = props.unread.get(chat.id) ?? 0;
              return (
                <option key={chat.id} value={chat.id}>
                  {chatName(chat)}
                  {unread > 0 ? ` (${unread} unread)` : ""}
                </option>
              );
            })}
          </select>
          {present && (
            <button type="button" className="icon-button" onClick={newTopic} title={`Start a topic with ${agent.name}, in a thread of its own`}>
              <Icon name="plus" size={16} />
              <span className="visually-hidden">New topic</span>
            </button>
          )}
        </div>
      )}
      {props.scope && present && <p className="chat-scope">{props.scope}</p>}

      <div className="drawer-body chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {messages.length === 0 && streaming.length === 0 && <p className="empty">{empty}</p>}
          <ol className="messages" aria-label={`Messages with ${agent.name}`}>
            {messages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                agentName={agent.name}
                run={message.runId ? runs[message.runId] : undefined}
                proposal={message.kind === "proposal" ? props.proposals.find((proposal) => proposal.id === message.refId) : undefined}
                policy={message.kind === "policy" ? props.policies.find((policy) => String(policy.id) === message.refId) : undefined}
                policies={props.policies}
                staffChange={message.kind === "staff_change" ? props.staffChanges.find((change) => String(change.id) === message.refId) : undefined}
                meeting={message.kind === "meeting" ? props.meetings.find((meeting) => meeting.id === message.refId) : undefined}
                onOpenMeeting={props.onOpenMeeting}
                models={props.models}
                readers={props.readers}
                services={props.services}
                serviceActions={props.serviceActions}
                onPreview={props.onPreview}
                onApprove={props.onApprove}
                onDecline={props.onDecline}
                onApprovePolicy={props.onApprovePolicy}
                onDeclinePolicy={props.onDeclinePolicy}
                onApproveStaffChange={props.onApproveStaffChange}
                onDeclineStaffChange={props.onDeclineStaffChange}
                resolveLink={props.resolveLink}
                onOpenLink={props.onOpenLink}
                views={props.views.get(message.id) ?? NO_VIEWS}
                renderView={renderView}
                nameOf={nameOf}
              />
            ))}
          </ol>
          <div className="messages streaming" aria-live="polite">
            {streaming.map((reply) => (
              <div key={reply.runId} className="message message-agent">
                <span className="visually-hidden">{agent.name} is replying: </span>
                <p className="bubble">
                  {reply.text}
                  <span className="caret" aria-hidden="true" />
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {present ? (
        <form className="composer" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor={inputId}>
            Message {agent.name}
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            rows={2}
            value={draft}
            maxLength={MAX_LENGTH}
            placeholder={`Message ${agent.name}`}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="send" disabled={draft.trim() === ""} title="Send">
            <Icon name="send" />
            <span className="visually-hidden">Send</span>
          </button>
          <p className="hint" id={hintId}>
            Enter sends. Shift+Enter adds a line.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="chat-closed" role="status">
          <Icon name="lock" size={16} />
          <span>
            {agent.name} has left the office, so the chat is closed. You can still read it.
          </span>
        </p>
      )}
    </Root>
  );
}

/** The full-screen chat's heading: whose chat and which topic, with a topic renamed in place. */
function PageTitle({ agent, conversation, onRename }: { agent: Agent; conversation: Conversation; onRename(title: string): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conversation.title);
  const [error, setError] = useState<string | null>(null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const title = name.trim();
    if (!title) return setError("A topic needs a name.");
    if (title === conversation.title) return setEditing(false);
    onRename(title).then(
      () => setEditing(false),
      (failure: unknown) => setError(`Couldn't rename it: ${errorText(failure)}`),
    );
  };
  return (
    <div className="drawer-title">
      <p className="eyebrow">
        {agent.name}
        {agent.title ? ` · ${agent.title}` : ""}
      </p>
      {editing ? (
        <form className="topic-rename" onSubmit={save}>
          <label className="visually-hidden" htmlFor={`rename-${conversation.id}`}>
            Topic name
          </label>
          <input
            id={`rename-${conversation.id}`}
            value={name}
            maxLength={60}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
          <button type="submit" className="icon-button" title="Save the name">
            <Icon name="check" size={16} />
            <span className="visually-hidden">Save the name</span>
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <h2 className="topic-title">
          <span>{chatName(conversation)}</span>
          {conversation.kind === "topic" && (
            <button
              type="button"
              className="icon-button small"
              onClick={() => {
                setName(conversation.title);
                setEditing(true);
              }}
              title="Rename the topic"
            >
              <Icon name="edit" size={14} />
              <span className="visually-hidden">Rename the topic</span>
            </button>
          )}
        </h2>
      )}
    </div>
  );
}

interface MessageViewProps {
  message: ChatMessage;
  agentName: string;
  run: Run | undefined;
  proposal: Proposal | undefined;
  policy: PolicyVersion | undefined;
  policies: PolicyVersion[];
  staffChange: StaffChange | undefined;
  meeting: Meeting | undefined;
  onOpenMeeting(meetingId: string): void;
  models: ModelOption[] | null;
  readers: StaffReader[];
  services: Service[];
  serviceActions: ServiceCardActions;
  onPreview(proposalId: string, sourcePath: string): Promise<SourcePreview>;
  onApprove(proposalId: string, sourcePath: string | undefined, unsafe: string[]): Promise<void>;
  onDecline(proposalId: string): Promise<void>;
  onApprovePolicy(policyId: number): Promise<void>;
  onDeclinePolicy(policyId: number): Promise<void>;
  onApproveStaffChange(changeId: number, unsafe: string[]): Promise<void>;
  onDeclineStaffChange(changeId: number): Promise<void>;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
  views: View[];
  renderView(view: View, byline: string | null): ReactNode;
  nameOf(agentId: string): string;
}

const NO_VIEWS: View[] = [];

function MessageView(props: MessageViewProps) {
  const { message, agentName, run, proposal, policy, readers, onPreview, onApprove, onDecline, resolveLink, onOpenLink } = props;
  const time = (
    <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
      {formatClock(message.createdAt)}
    </time>
  );

  if (message.kind === "notice") {
    return (
      <li className="message message-notice">
        <span className="visually-hidden">AiHub notice: </span>
        <p>
          <Icon name="warning" size={14} /> {message.body} <span className="muted">· {time}</span>
        </p>
      </li>
    );
  }

  if (message.kind === "proposal") {
    return (
      <li className="message message-card">
        <ProposalCard
          proposal={proposal}
          intro={message.body}
          readers={readers}
          services={props.services}
          models={props.models}
          onPreview={(sourcePath) => onPreview(message.refId ?? "", sourcePath)}
          onApprove={(sourcePath, unsafe) => onApprove(message.refId ?? "", sourcePath, unsafe)}
          onDecline={() => onDecline(message.refId ?? "")}
        />
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  if (message.kind === "service") {
    const serviceId = message.refId ?? "";
    const actions = props.serviceActions;
    return (
      <li className="message message-card">
        <ServiceCard
          service={props.services.find((service) => service.id === serviceId)}
          intro={message.body}
          onApprove={(unsafe) => actions.approve(serviceId, unsafe)}
          onDecline={() => actions.decline(serviceId)}
          onSignIn={() => actions.signIn(serviceId)}
          onRefresh={() => actions.refresh(serviceId)}
        />
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  if (message.kind === "policy") {
    return (
      <li className="message message-card">
        <PolicyCard
          policy={policy}
          intro={message.body}
          base={policy ? baseOf(policy, props.policies) : null}
          authorName={agentName}
          onApprove={() => props.onApprovePolicy(Number(message.refId))}
          onDecline={() => props.onDeclinePolicy(Number(message.refId))}
        />
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  if (message.kind === "staff_change") {
    return (
      <li className="message message-card">
        <StaffChangeCard
          change={props.staffChange}
          intro={message.body}
          authorName={agentName}
          models={props.models}
          onApprove={(unsafe) => props.onApproveStaffChange(Number(message.refId), unsafe)}
          onDecline={() => props.onDeclineStaffChange(Number(message.refId))}
        />
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  if (message.kind === "meeting") {
    const meeting = props.meeting;
    const status = meeting ? meetingStatus(meeting) : "ended";
    return (
      <li className="message message-card">
        <button type="button" className="card meeting-link" onClick={() => props.onOpenMeeting(message.refId ?? "")} disabled={!meeting}>
          <span className="meeting-mark" aria-hidden="true">
            <Icon name="team" size={18} />
          </span>
          <span className="meeting-link-text">
            <span className="eyebrow">Meeting</span>
            <span className="meeting-link-title">{meeting?.title ?? message.body}</span>
          </span>
          <span className={`pill meeting-status-${status}`}>{MEETING_STATUS_LABELS[status]}</span>
          {meeting && <Icon name="chevron" size={16} />}
        </button>
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  if (message.kind === "review") {
    return (
      <li className="message message-agent message-review">
        <span className="visually-hidden">{agentName}'s staff review: </span>
        <div className="bubble">
          <p className="eyebrow review-label">
            <Icon name="team" size={14} /> Staff review
          </p>
          <Markdown source={message.body} resolveLink={resolveLink} onOpenLink={onOpenLink} />
        </div>
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  if (message.kind === "briefing") {
    return (
      <li className="message message-card">
        <article className="morning-paper" aria-label={`Briefing for ${formatLongDate(message.createdAt)}`}>
          <header className="paper-masthead">
            <p className="paper-name">The Morning Brief</p>
            <p className="paper-dateline">
              <span>{formatLongDate(message.createdAt)}</span>
              <span>Delivered {formatClock(message.createdAt)}</span>
            </p>
          </header>
          <Markdown source={message.body} className="paper-body" resolveLink={resolveLink} onOpenLink={onOpenLink} />
          {props.views.length > 0 && (
            <div className="paper-views">{props.views.map((view) => props.renderView(view, `from ${props.nameOf(view.agentId)}`))}</div>
          )}
        </article>
      </li>
    );
  }

  const fromOperator = message.author === "operator";
  return (
    <li className={`message ${fromOperator ? "message-operator" : "message-agent"}`}>
      <span className="visually-hidden">{fromOperator ? "You" : agentName}: </span>
      {fromOperator ? (
        <p className="bubble">{message.body}</p>
      ) : (
        <div className="bubble">
          <Markdown source={message.body} resolveLink={resolveLink} onOpenLink={onOpenLink} />
        </div>
      )}
      {!fromOperator && props.views.length > 0 && <div className="message-views">{props.views.map((view) => props.renderView(view, null))}</div>}
      <p className="message-meta">
        {time}
        {fromOperator && run && <RunStatus run={run} />}
      </p>
    </li>
  );
}

/** How the reply to an operator message is going. A finished reply speaks for itself. */
function RunStatus({ run }: { run: Run }) {
  if (run.state === "done") return null;
  if (run.state === "failed") {
    return <span className="run-status tone-failed">Failed{run.error ? `: ${run.error}` : ""}</span>;
  }
  return <span className={`run-status tone-${toneOf(run.state)}`}>{STATE_LABELS[run.state]}…</span>;
}
