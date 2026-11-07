import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Agent, ChatMessage, Conversation, Proposal, Run } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { formatClock, formatDateTime, formatLongDate, STATE_LABELS, toneOf } from "../format.ts";
import type { StreamingReply } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { Markdown, type WikilinkTarget } from "./Markdown.tsx";
import { Portrait } from "./office/Figure.tsx";
import { ProposalCard } from "./ProposalCard.tsx";
import { StateBadge } from "./StateBadge.tsx";

/** The daemon rejects longer messages. */
const MAX_LENGTH = 20_000;
/** How close to the bottom, in pixels, still counts as following the conversation. */
const FOLLOW_SLACK = 48;

interface ChatDrawerProps {
  agent: Agent;
  conversation: Conversation;
  messages: ChatMessage[];
  runs: Record<string, Run>;
  streaming: StreamingReply[];
  proposals: Proposal[];
  onSend(text: string): Promise<void>;
  onApprove(proposalId: string, sourcePath?: string): Promise<void>;
  onDecline(proposalId: string): Promise<void>;
  onClose(): void;
  onOpenProfile(): void;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
}

export function ChatDrawer(props: ChatDrawerProps) {
  const { agent, conversation, messages, runs, streaming, onSend } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Follow new messages unless the operator has scrolled up to read earlier ones.
  const following = useRef(true);

  useEffect(() => inputRef.current?.focus(), []);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, streaming, runs, props.proposals]);

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

  const inputId = `chat-input-${conversation.id}`;
  const hintId = `chat-hint-${conversation.id}`;
  const titleId = `chat-title-${conversation.id}`;

  return (
    <aside className="drawer chat-drawer" aria-labelledby={titleId}>
      <header className="drawer-head">
        <button type="button" className="drawer-avatar" onClick={props.onOpenProfile} title={`Open ${agent.name}'s profile`}>
          <Portrait look={lookFor(agent.avatar)} size={40} />
          <span className="visually-hidden">Open {agent.name}'s profile</span>
        </button>
        <div className="drawer-title">
          <h2 id={titleId}>{agent.name}</h2>
          <p className="muted small">
            {conversation.title && conversation.title !== agent.name ? `${agent.title} · ${conversation.title}` : agent.title}
          </p>
        </div>
        <StateBadge state={agent.state} />
        <button type="button" className="icon-button" onClick={props.onClose} title="Close the chat">
          <Icon name="close" />
          <span className="visually-hidden">Close the chat</span>
        </button>
      </header>

      <div className="drawer-body chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 && streaming.length === 0 && <p className="empty">No messages yet. Ask {agent.name} anything.</p>}
        <ol className="messages" aria-label={`Messages with ${agent.name}`}>
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              agentName={agent.name}
              run={message.runId ? runs[message.runId] : undefined}
              proposal={message.kind === "proposal" ? props.proposals.find((proposal) => proposal.id === message.refId) : undefined}
              onApprove={props.onApprove}
              onDecline={props.onDecline}
              resolveLink={props.resolveLink}
              onOpenLink={props.onOpenLink}
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
    </aside>
  );
}

interface MessageViewProps {
  message: ChatMessage;
  agentName: string;
  run: Run | undefined;
  proposal: Proposal | undefined;
  onApprove(proposalId: string, sourcePath?: string): Promise<void>;
  onDecline(proposalId: string): Promise<void>;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
}

function MessageView({ message, agentName, run, proposal, onApprove, onDecline, resolveLink, onOpenLink }: MessageViewProps) {
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
          onApprove={(sourcePath) => onApprove(message.refId ?? "", sourcePath)}
          onDecline={() => onDecline(message.refId ?? "")}
        />
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
