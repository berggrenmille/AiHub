import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Agent, ChatMessage, Conversation, Meeting, MeetingOutcome, Run } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { floorLine, MEETING_STATUS_LABELS, meetingStatus, proposedOutcome } from "../lib/meetings.ts";
import { formatClock, formatDateTime } from "../format.ts";
import type { StreamingReply } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { Markdown, type WikilinkTarget } from "./Markdown.tsx";
import { Portrait } from "./office/Figure.tsx";

// A meeting full screen (DESIGN.md › Meetings): the Chief of Staff chairs, the supervisors invited
// speak in turn, and the operator can speak at any point. Its conclusion waits here for approval.

/** The daemon rejects longer messages. */
const MAX_LENGTH = 20_000;
/** How close to the bottom, in pixels, still counts as following the meeting. */
const FOLLOW_SLACK = 48;

interface MeetingPanelProps {
  conversation: Conversation;
  /** Null for a meeting old enough to have dropped out of the office's list: it reads as ended. */
  meeting: Meeting | null;
  messages: ChatMessage[];
  runs: Record<string, Run>;
  streaming: StreamingReply[];
  /** Anyone who has been on staff, as last seen. */
  personOf(agentId: string): Agent | null;
  onSay(text: string): Promise<void>;
  onApprove(outcomeId: number): Promise<void>;
  onEnd(): Promise<void>;
  onOpenProfile(agentId: string): void;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
}

export function MeetingPanel(props: MeetingPanelProps) {
  const { conversation, meeting, messages, runs, streaming, personOf } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const status = meeting ? meetingStatus(meeting) : "ended";
  const open = status !== "ended";
  const nameOf = (agentId: string) => personOf(agentId)?.name ?? "Someone who left";
  const proposed = meeting ? proposedOutcome(meeting) : null;
  const room = meeting ? [meeting.chairId, ...meeting.participantIds] : [conversation.agentId];
  const floor = meeting && status === "live" ? (meeting.queue[0] ?? null) : null;

  useEffect(() => inputRef.current?.focus(), []);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, streaming, meeting]);

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
    props.onSay(text).catch((failure: unknown) => {
      setError(`Couldn't say that in the meeting: ${errorText(failure)}`);
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

  const end = () => {
    setError(null);
    props.onEnd().then(
      () => setConfirmEnd(false),
      (failure: unknown) => setError(`Couldn't end the meeting: ${errorText(failure)}`),
    );
  };

  const inputId = `meeting-input-${conversation.id}`;
  const hintId = `meeting-hint-${conversation.id}`;
  const chair = meeting ? personOf(meeting.chairId) : null;

  return (
    <section className="chat-page meeting-page" aria-label={`Meeting: ${conversation.title}`}>
      <header className="drawer-head chat-head meeting-head">
        <span className="meeting-mark" aria-hidden="true">
          <Icon name="team" size={22} />
        </span>
        <div className="drawer-title">
          <p className="eyebrow">Meeting{chair ? ` · chaired by ${chair.name}` : ""}</p>
          <h2 className="topic-title">
            <span>{conversation.title}</span>
          </h2>
        </div>
        <span className={`pill meeting-status-${status}`}>{MEETING_STATUS_LABELS[status]}</span>
        {open &&
          (confirmEnd ? (
            <span className="meeting-end-confirm">
              <button type="button" className="button danger small" onClick={end}>
                End it
              </button>
              <button type="button" className="button ghost small" onClick={() => setConfirmEnd(false)}>
                Keep going
              </button>
            </span>
          ) : (
            <button type="button" className="hud-button" onClick={() => setConfirmEnd(true)} title="End the meeting without approving anything">
              <Icon name="close" size={16} />
              <span>End meeting</span>
            </button>
          ))}
      </header>
      <div className="meeting-room">
        <ul className="meeting-people" aria-label="In the room">
          {room.map((agentId) => {
            const person = personOf(agentId);
            const name = person?.name ?? "Someone who left";
            const speaking = agentId === floor;
            return (
              <li key={agentId} className={`meeting-person${speaking ? " has-floor" : ""}`}>
                <button type="button" className="meeting-person-button" disabled={!person} onClick={() => props.onOpenProfile(agentId)} title={speaking ? `${name} has the floor` : `Open ${name}'s profile`}>
                  <Portrait look={lookFor(person?.avatar ?? name)} size={32} animated={speaking} />
                  <span className="meeting-person-name">{name}</span>
                  {agentId === meeting?.chairId && <span className="visually-hidden"> (chair)</span>}
                  {speaking && <span className="visually-hidden"> has the floor</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {meeting && <p className="meeting-floor">{floorLine(meeting, nameOf)}</p>}
      </div>

      <div className="drawer-body chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          <ol className="messages meeting-messages" aria-label={`Messages in ${conversation.title}`}>
            {messages.map((message) => (
              <MeetingMessage
                key={message.id}
                message={message}
                personOf={personOf}
                outcome={message.kind === "meeting" ? meeting?.outcomes.find((outcome) => String(outcome.id) === message.refId) : undefined}
                waiting={meeting?.state === "waiting"}
                onApprove={props.onApprove}
                onEnd={props.onEnd}
                resolveLink={props.resolveLink}
                onOpenLink={props.onOpenLink}
              />
            ))}
          </ol>
          <div className="messages streaming" aria-live="polite">
            {streaming.map((reply) => {
              const agentId = runs[reply.runId]?.agentId;
              const person = agentId ? personOf(agentId) : null;
              return (
                <div key={reply.runId} className="message message-agent meeting-message">
                  <Byline person={person} />
                  <span className="visually-hidden">{person?.name ?? "Someone"} is speaking: </span>
                  <p className="bubble">
                    {reply.text}
                    <span className="caret" aria-hidden="true" />
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {open ? (
        <form className="composer" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor={inputId}>
            Speak in the meeting
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            rows={2}
            value={draft}
            maxLength={MAX_LENGTH}
            placeholder={proposed ? "Reply to change the conclusion" : "Speak to the room"}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="send" disabled={draft.trim() === ""} title="Send">
            <Icon name="send" />
            <span className="visually-hidden">Send</span>
          </button>
          <p className="hint" id={hintId}>
            {status === "live" ? "Everyone who speaks after this hears it." : proposed ? `${chair?.name ?? "The chair"} takes it in and concludes again.` : "What you say starts it again."}{" "}
            Enter sends.
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
            This meeting has ended. Results of the tasks it handed out still come back here. Call a new meeting to talk again.
          </span>
        </p>
      )}
    </section>
  );
}

function Byline({ person }: { person: Agent | null }) {
  const name = person?.name ?? "Someone who left";
  return (
    <p className="meeting-byline">
      <Portrait look={lookFor(person?.avatar ?? name)} size={20} animated={false} />
      <span className="meeting-byline-name">{name}</span>
      {person?.title && <span className="muted"> · {person.title}</span>}
    </p>
  );
}

interface MeetingMessageProps {
  message: ChatMessage;
  personOf(agentId: string): Agent | null;
  outcome: MeetingOutcome | undefined;
  /** The meeting waits for the operator, so a proposed conclusion can be decided. */
  waiting: boolean;
  onApprove(outcomeId: number): Promise<void>;
  onEnd(): Promise<void>;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
}

function MeetingMessage({ message, personOf, outcome, waiting, onApprove, onEnd, resolveLink, onOpenLink }: MeetingMessageProps) {
  const person = message.agentId ? personOf(message.agentId) : null;
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

  if (message.kind === "pass") {
    return (
      <li className="message meeting-pass">
        <p>
          <Portrait look={lookFor(person?.avatar ?? "someone")} size={16} animated={false} />
          <span>
            {/* A pass AiHub made, such as at the standup for someone with nothing new, took no turn. */}
            {person?.name ?? "Someone"} passed{message.runId === null ? " without a turn" : ""}: {message.body}
          </span>
          <span className="muted"> · {time}</span>
        </p>
      </li>
    );
  }

  if (message.kind === "meeting") {
    return (
      <li className="message message-card">
        <MeetingOutcomeCard outcome={outcome} chairName={person?.name ?? "The chair"} waiting={waiting} onApprove={onApprove} onEnd={onEnd} resolveLink={resolveLink} onOpenLink={onOpenLink} />
        <p className="message-meta">{time}</p>
      </li>
    );
  }

  const fromOperator = message.author === "operator";
  return (
    <li className={`message meeting-message ${fromOperator ? "message-operator" : "message-agent"}`}>
      {!fromOperator && <Byline person={person} />}
      <span className="visually-hidden">{fromOperator ? "You" : (person?.name ?? "Someone")}: </span>
      {fromOperator ? (
        <p className="bubble">{message.body}</p>
      ) : (
        <div className="bubble">
          <Markdown source={message.body} resolveLink={resolveLink} onOpenLink={onOpenLink} />
        </div>
      )}
      <p className="message-meta">{time}</p>
    </li>
  );
}

const OUTCOME_LABELS: Record<MeetingOutcome["status"], string> = {
  proposed: "Waiting for you",
  approved: "Approved",
  declined: "Not approved",
  superseded: "Set aside",
};

interface MeetingOutcomeCardProps {
  outcome: MeetingOutcome | undefined;
  chairName: string;
  waiting: boolean;
  onApprove(outcomeId: number): Promise<void>;
  onEnd(): Promise<void>;
  resolveLink(target: string): WikilinkTarget;
  onOpenLink(target: string): void;
}

/** The chair's conclusion: what the meeting decided and who does what. Nothing starts until the operator approves. */
export function MeetingOutcomeCard({ outcome, chairName, waiting, onApprove, onEnd, resolveLink, onOpenLink }: MeetingOutcomeCardProps) {
  const [busy, setBusy] = useState<"approve" | "end" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!outcome) {
    return (
      <div className="card meeting-card">
        <p className="muted small">This conclusion is no longer on file.</p>
      </div>
    );
  }

  const decide = async (which: "approve" | "end") => {
    setBusy(which);
    setError(null);
    try {
      await (which === "approve" ? onApprove(outcome.id) : onEnd());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const pending = outcome.status === "proposed" && waiting;
  return (
    <article className={`card meeting-card status-${outcome.status}`} aria-label="Conclusion of the meeting">
      <header className="policy-card-head">
        <Icon name="team" size={18} />
        <p className="eyebrow">Conclusion</p>
        <span className={`pill meeting-outcome-${outcome.status}`}>{OUTCOME_LABELS[outcome.status]}</span>
      </header>
      <Markdown source={outcome.summary} resolveLink={resolveLink} onOpenLink={onOpenLink} />
      {outcome.decisions.length > 0 && (
        <section className="meeting-card-section">
          <h3 className="eyebrow">Decided</h3>
          <ul className="meeting-decisions">
            {outcome.decisions.map((decision, index) => (
              <li key={index}>
                <Icon name="check" size={14} /> {decision}
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.tasks.length > 0 && (
        <section className="meeting-card-section">
          <h3 className="eyebrow">Tasks</h3>
          <ul className="meeting-tasks">
            {outcome.tasks.map((task, index) => (
              <li key={index}>
                <p>
                  <strong>{task.ownerName}</strong>: {task.title}
                  {task.assignmentId !== null && <span className="pill small">Handed out</span>}
                </p>
                <p className="muted small">{task.deliverable}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.fromSourceData && pending && (
        <p className="callout warn">
          <Icon name="warning" size={16} /> Supervisors spoke from what their sources hold, so {chairName} wrote this from source data. Check the tasks are ones you want done.
        </p>
      )}
      {pending ? (
        <>
          <div className="button-row">
            <button type="button" className="button primary" disabled={busy !== null} onClick={() => void decide("approve")}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : outcome.tasks.length ? "Approve and hand out tasks" : "Approve"}
            </button>
            <button type="button" className="button ghost" disabled={busy !== null} onClick={() => void decide("end")}>
              {busy === "end" ? "Ending…" : "End without approving"}
            </button>
          </div>
          <p className="muted small">Reply in the meeting to change it.</p>
        </>
      ) : (
        <p className="muted small">
          {outcome.status === "superseded"
            ? "Set aside: you replied, so the chair took it in."
            : outcome.status === "approved"
              ? `Approved${outcome.decidedAt ? ` ${formatDateTime(outcome.decidedAt)}` : ""}.${outcome.tasks.length ? " Results come back to this meeting." : ""}`
              : outcome.status === "declined"
                ? "Not approved: the meeting ended without it."
                : null}
        </p>
      )}
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
