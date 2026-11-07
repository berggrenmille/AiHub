import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Agent, ChatMessage, Conversation, Run } from "@aihub/shared";
import { formatClock, formatDateTime, STATE_LABELS, toneOf } from "../format.ts";
import type { StreamingReply } from "../state.ts";
import { StateBadge } from "./StateBadge.tsx";

/** The daemon rejects longer messages. */
const MAX_LENGTH = 20_000;
/** How close to the bottom, in pixels, still counts as following the conversation. */
const FOLLOW_SLACK = 48;

interface ChatProps {
  agent: Agent;
  conversation: Conversation;
  messages: ChatMessage[];
  runs: Record<string, Run>;
  streaming: StreamingReply[];
  onSend(text: string): Promise<void>;
}

export function Chat({ agent, conversation, messages, runs, streaming, onSend }: ChatProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new messages unless the operator has scrolled up to read earlier ones.
  const following = useRef(true);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, streaming, runs]);

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
      setError(`Couldn't send the message: ${failure instanceof Error ? failure.message : String(failure)}`);
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

  return (
    <section className="panel chat" aria-labelledby="chat-title">
      <div className="panel-title chat-title">
        <h2 id="chat-title">{conversation.title}</h2>
        <StateBadge state={agent.state} />
      </div>

      <div className="panel-body chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 && streaming.length === 0 && (
          <p className="empty">No messages yet. Ask the {agent.name} anything.</p>
        )}
        <ol className="messages" aria-label={`Messages with ${agent.name}`}>
          {messages.map((message) => (
            <Message key={message.id} message={message} agentName={agent.name} run={message.runId ? runs[message.runId] : undefined} />
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
          Message the {agent.name}
        </label>
        <textarea
          id={inputId}
          rows={2}
          value={draft}
          maxLength={MAX_LENGTH}
          placeholder={`Message the ${agent.name}`}
          aria-describedby={hintId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="send" disabled={draft.trim() === ""}>
          Send
        </button>
        <p className="hint" id={hintId}>
          Enter sends. Shift+Enter adds a line.
        </p>
        {error && (
          <p className="send-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function Message({ message, agentName, run }: { message: ChatMessage; agentName: string; run: Run | undefined }) {
  const fromOperator = message.author === "operator";
  return (
    <li className={`message ${fromOperator ? "message-operator" : "message-agent"}`}>
      <span className="visually-hidden">{fromOperator ? "You" : agentName}: </span>
      <p className="bubble">{message.body}</p>
      <p className="message-meta">
        <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
          {formatClock(message.createdAt)}
        </time>
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
