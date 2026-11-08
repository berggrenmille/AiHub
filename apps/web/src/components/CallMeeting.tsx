import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, Meeting, OfficeStats } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { meetingTurns } from "../lib/meetings.ts";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";

// The operator calls a meeting (DESIGN.md › Meetings): what to settle and which supervisors come.
// The Chief of Staff chairs; every turn in it comes out of the day's budget.

interface CallMeetingProps {
  supervisors: Agent[];
  chief: Agent | null;
  /** The meeting under way, if any: only one runs at a time. */
  running: Meeting | null;
  office: OfficeStats | null;
  onCall(agenda: string, participantIds: string[] | undefined): Promise<Meeting>;
  onCalled(meeting: Meeting): void;
  onOpenRunning(meetingId: string): void;
  onCancel(): void;
}

export function CallMeeting({ supervisors, chief, running, office, onCall, onCalled, onOpenRunning, onCancel }: CallMeetingProps) {
  const [agenda, setAgenda] = useState("");
  const [invited, setInvited] = useState<ReadonlySet<string>>(() => new Set(supervisors.map((agent) => agent.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agendaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => agendaRef.current?.focus(), []);

  const chair = chief?.name ?? "The Chief of Staff";
  const coming = supervisors.filter((agent) => invited.has(agent.id));
  const turns = meetingTurns(coming.length);
  const left = office ? Math.max(0, office.dailyTurnLimit - office.turnsToday) : null;

  const toggle = (agentId: string) =>
    setInvited((current) => {
      const next = new Set(current);
      if (!next.delete(agentId)) next.add(agentId);
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = agenda.trim();
    if (!text) return setError("Say what the meeting is to settle.");
    if (!coming.length) return setError("Invite at least one supervisor.");
    setBusy(true);
    setError(null);
    try {
      // Everyone invited means every supervisor, including any hired before it starts.
      const meeting = await onCall(text, coming.length === supervisors.length ? undefined : coming.map((agent) => agent.id));
      onCalled(meeting);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <section className="chat-page call-meeting" aria-labelledby="call-meeting-title">
      <header className="drawer-head chat-head meeting-head">
        <span className="meeting-mark" aria-hidden="true">
          <Icon name="team" size={22} />
        </span>
        <div className="drawer-title">
          <p className="eyebrow">{chair} chairs</p>
          <h2 id="call-meeting-title">Call a meeting</h2>
        </div>
        <button type="button" className="icon-button" onClick={onCancel} title="Cancel">
          <Icon name="close" />
          <span className="visually-hidden">Cancel</span>
        </button>
      </header>
      <div className="drawer-body">
        <form className="call-meeting-form" onSubmit={(event) => void submit(event)}>
          {supervisors.length === 0 ? (
            <p className="empty">There are no supervisors to meet with yet. Ask {chair} to recruit some.</p>
          ) : (
            <>
              <div className="field">
                <label className="field-label" htmlFor="meeting-agenda">
                  What should the meeting settle?
                </label>
                <textarea
                  id="meeting-agenda"
                  aria-describedby="meeting-agenda-hint"
                  ref={agendaRef}
                  rows={4}
                  maxLength={2_000}
                  value={agenda}
                  placeholder={"Plan the week\nWhat's due, what clashes, and who takes what."}
                  onChange={(event) => {
                    setAgenda(event.target.value);
                    setError(null);
                  }}
                />
                <span className="hint" id="meeting-agenda-hint">
                  The first line names the meeting. Everyone hears the rest before they speak.
                </span>
              </div>
              <fieldset className="field call-meeting-invite">
                <legend className="field-label">Who comes</legend>
                <ul>
                  {supervisors.map((agent) => (
                    <li key={agent.id}>
                      <label className="call-meeting-person">
                        <input type="checkbox" checked={invited.has(agent.id)} onChange={() => toggle(agent.id)} />
                        <Portrait look={lookFor(agent.avatar)} size={28} animated={false} />
                        <span className="chats-person-name">
                          <span className="agent-name">{agent.name}</span>
                          <span className="agent-role">{agent.title}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <p className="muted small call-meeting-cost">
                <Icon name="energy" size={14} /> The first round takes {turns.first} turns: one from each supervisor and one from {chair}. {chair} can ask for up to two
                more rounds, so at most {turns.most}.{left !== null && ` ${left} turns are left today.`}
              </p>
              {left === 0 && (
                <p className="callout warn">
                  <Icon name="warning" size={16} />
                  <span>Today's turns are used up, so the meeting would wait until tomorrow before anyone speaks.</span>
                </p>
              )}
              {running && (
                <p className="callout warn">
                  <Icon name="warning" size={16} />
                  <span>
                    "{running.title}" is under way, and only one meeting runs at a time.{" "}
                    <button type="button" className="link-button" onClick={() => onOpenRunning(running.id)}>
                      Open it
                    </button>
                  </span>
                </p>
              )}
              <div className="button-row">
                <button type="submit" className="button primary" disabled={busy || running !== null || !agenda.trim() || !coming.length}>
                  <Icon name="team" size={16} /> {busy ? "Calling…" : "Call the meeting"}
                </button>
                <button type="button" className="button ghost" onClick={onCancel}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
