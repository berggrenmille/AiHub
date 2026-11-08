import type { CSSProperties } from "react";
import { MEETING_ROUNDS, type Meeting } from "@aihub/shared";
import { hashSeed, type Look } from "../../lib/avatar.ts";
import { meetingTable, type MeetingSeat, type Rect } from "../../lib/layout.ts";
import { MEETING_STATUS_LABELS, meetingStatus } from "../../lib/meetings.ts";
import { Figure } from "./Figure.tsx";

// The meeting room under the hall (DESIGN.md › The office experience): while a meeting runs, those
// in it sit along the one long table, the chair in the middle, and whoever is speaking talks there.
// The screen on the wall says what is under way, or that the conclusion waits for the operator.

interface MeetingRoomProps {
  room: Rect;
  /** The meeting under way, or the latest one waiting for the operator. */
  meeting: Meeting | null;
  /** Places at the table, only while the meeting runs. */
  seats: MeetingSeat[];
  looks: Map<string, Look>;
  nameOf(agentId: string): string;
  /** Who is speaking now, with what they say so far. */
  speaker: { agentId: string; text: string } | null;
  /** Who just came in, with how far their desk is, to walk in from it. */
  arriving: Map<string, { dx: number; dy: number }>;
  onOpen(meetingId: string): void;
}

const EMPTY_CHAIRS = 8;

export function MeetingRoom({ room, meeting, seats, looks, nameOf, speaker, arriving, onOpen }: MeetingRoomProps) {
  const status = meeting ? meetingStatus(meeting) : null;
  const live = status === "live";
  const table = meetingTable(room);
  const tableW = table.right - table.left;
  const tableTop = table.y - room.y;
  const spacing = seats.length > 1 ? seats[1]!.x - seats[0]!.x : 96;
  const floor = live && meeting ? meeting.queue[0] ?? null : null;
  const speakerSeat = speaker ? seats.find((seat) => seat.agentId === speaker.agentId) : undefined;

  const content = (
    <>
      <span className={`meeting-screen${status ? ` status-${status}` : ""}`} aria-hidden="true">
        {meeting && status ? (
          <>
            <span className="meeting-screen-state">{MEETING_STATUS_LABELS[status]}</span>
            <span className="meeting-screen-title">{meeting.title}</span>
            <span className="meeting-screen-line">
              {live ? `Round ${meeting.round} of ${MEETING_ROUNDS}` : status === "needs_you" ? "The conclusion waits for you" : "Say something to carry on"}
            </span>
          </>
        ) : (
          <span className="meeting-screen-idle">No meeting</span>
        )}
      </span>

      {!live && (
        <svg className="meeting-chairs" style={{ left: table.left - room.x, top: tableTop - 56, width: tableW, height: 56 }} viewBox={`0 0 ${tableW} 56`} aria-hidden="true">
          {Array.from({ length: EMPTY_CHAIRS }, (_, index) => {
            const x = (tableW / EMPTY_CHAIRS) * (index + 0.5);
            return <rect key={index} x={x - 21} y={8} width={42} height={52} rx={11} fill="var(--chair)" />;
          })}
        </svg>
      )}

      {live &&
        seats.map((seat) => {
          const look = looks.get(seat.agentId);
          if (!look) return null;
          const from = arriving.get(seat.agentId);
          const style: CSSProperties & Record<string, string | number> = {
            left: seat.x - room.x,
            top: seat.y - room.y,
            width: 100 * seat.scale,
            height: 100 * seat.scale,
            "--delay": `-${hashSeed(seat.agentId) % 5000}ms`,
          };
          if (from) {
            style["--from-x"] = `${from.dx}px`;
            style["--from-y"] = `${from.dy}px`;
          }
          const talking = speaker?.agentId === seat.agentId;
          return (
            <span key={seat.agentId} className={`meeting-seat${from ? " arriving" : ""}${seat.agentId === floor ? " has-floor" : ""}`} style={style} aria-hidden="true">
              <svg viewBox="20 20 100 100" width="100%" height="100%" overflow="visible">
                <rect x={45} y={46} width={50} height={56} rx={12} fill="var(--chair)" />
                <rect x={49} y={50} width={42} height={48} rx={10} fill="var(--chair-hi)" opacity={0.5} />
                <Figure look={look} pose={talking ? "raised" : "rest"} talking={talking} />
              </svg>
            </span>
          );
        })}

      <svg className="meeting-table" style={{ left: table.left - room.x, top: tableTop, width: tableW, height: 40 }} viewBox={`0 0 ${tableW} 40`} aria-hidden="true">
        <rect x={0} y={0} width={tableW} height={14} rx={6} fill="var(--desk-top)" />
        <rect x={0} y={0} width={tableW} height={2.5} rx={1.2} fill="#fff" opacity={0.18} />
        <rect x={4} y={13} width={tableW - 8} height={24} rx={4} fill="var(--desk-front)" />
        {!live && (
          <g opacity={0.9}>
            <rect x={tableW / 2 - 60} y={3} width={18} height={8} rx={1} fill="#f3f1e7" transform={`rotate(-6 ${tableW / 2 - 51} 7)`} />
            <circle cx={tableW / 2 + 40} cy={7} r={4} fill="#7dd3fc" opacity={0.7} />
          </g>
        )}
      </svg>

      {live &&
        seats.map((seat) => (
          <span
            key={`name-${seat.agentId}`}
            className={`meeting-name${seat.agentId === meeting?.chairId ? " chair" : ""}`}
            style={{ left: seat.x - room.x + 50 * seat.scale - spacing / 2, top: tableTop + 18, width: spacing }}
            aria-hidden="true"
          >
            <span>{nameOf(seat.agentId)}</span>
          </span>
        ))}

      {speaker && speakerSeat && (
        <span className="speech meeting-speech" style={{ left: speakerSeat.x - room.x + 50 * speakerSeat.scale, bottom: room.h - (speakerSeat.y - room.y + 6) }} aria-hidden="true">
          {speaker.text}
          <span className="caret" />
        </span>
      )}
    </>
  );

  if (!meeting || !status) {
    return (
      <div className="meeting-room" style={{ left: room.x, top: room.y, width: room.w, height: room.h }} aria-hidden="true">
        {content}
      </div>
    );
  }
  const who = seats.map((seat) => nameOf(seat.agentId)).join(", ");
  const label = live
    ? `Meeting: ${meeting.title}. Round ${meeting.round}${floor ? `, ${nameOf(floor)} has the floor` : ""}. At the table: ${who}. Open the meeting.`
    : `Meeting: ${meeting.title}. ${status === "needs_you" ? "The conclusion waits for you." : "Paused."} Open the meeting.`;
  return (
    <button type="button" className={`meeting-room status-${status}`} style={{ left: room.x, top: room.y, width: room.w, height: room.h }} aria-label={label} title={meeting.title} onClick={() => onOpen(meeting.id)}>
      {content}
    </button>
  );
}
