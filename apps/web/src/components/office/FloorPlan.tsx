import { memo } from "react";
import type { Daylight } from "../../lib/daylight.ts";
import { STATION, type OfficeLayout, type Rect } from "../../lib/layout.ts";
import { SpareDesk } from "./Station.tsx";

// The floor under everyone: walls, windows with the Stockholm sky, the Chief of Staff's glass
// office, the lounge by the door, the hall with the team pods, the meeting room under it, and some
// furniture. Original art. The meeting table and those at it are drawn over this, by MeetingRoom.

interface FloorPlanProps {
  layout: OfficeLayout;
  daylight: Daylight;
  /** Rug colors for occupied pods, by pod ID. */
  podColors: Record<string, string>;
  chiefColor: string;
  /** Local hour and minute for the wall clock. */
  clock: { hour: number; minute: number };
}

const SKIES: Record<Daylight["phase"], [string, string]> = {
  night: ["#0b1430", "#1c2b55"],
  dawn: ["#f7a07c", "#ffd9a8"],
  day: ["#6fb7ff", "#cfeaff"],
  dusk: ["#5b4b9a", "#f08a6c"],
};

export const FloorPlan = memo(function FloorPlan({ layout, daylight, podColors, chiefColor, clock }: FloorPlanProps) {
  const { width, height, wall, chiefRoom, lounge, hall, meetingRoom, pods } = layout;
  const [skyTop, skyBottom] = SKIES[daylight.phase];
  const windows = windowSpots(width);
  return (
    <svg className="floorplan" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="planks" width="120" height="28" patternUnits="userSpaceOnUse">
          <rect width="120" height="28" fill="var(--floor)" />
          <path d="M0 27.5 H120 M60 0 V14 M20 14 V28 M100 14 V28 M0 14 H120" stroke="var(--floor-line)" strokeWidth="1" />
        </pattern>
        <pattern id="carpet" width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="16" height="16" fill="var(--carpet)" />
          <circle cx="4" cy="4" r="1" fill="var(--carpet-dot)" />
          <circle cx="12" cy="12" r="1" fill="var(--carpet-dot)" />
        </pattern>
        <pattern id="tiles" width="36" height="36" patternUnits="userSpaceOnUse">
          <rect width="36" height="36" fill="var(--tile)" />
          <path d="M0 35.5 H36 M35.5 0 V36" stroke="var(--tile-line)" strokeWidth="1" />
        </pattern>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={skyTop} />
          <stop offset="100%" stopColor={skyBottom} />
        </linearGradient>
        <linearGradient id="sunbeam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff6d6" stopOpacity={0.22 * daylight.light} />
          <stop offset="100%" stopColor="#fff6d6" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Building shell and floors */}
      <rect width={width} height={height} rx={18} fill="var(--wall-outer)" />
      <rect x={8} y={8} width={width - 16} height={height - 16} rx={12} fill="url(#planks)" />
      <rect x={lounge.x} y={lounge.y} width={lounge.w} height={lounge.h} rx={10} fill="url(#tiles)" />

      {/* Top wall with windows */}
      <rect x={8} y={8} width={width - 16} height={wall - 8} rx={10} fill="var(--wall)" />
      <rect x={8} y={wall - 6} width={width - 16} height={6} fill="var(--wall-trim)" />
      {windows.map((x) => (
        <g key={x}>
          <rect x={x} y={16} width={96} height={wall - 28} rx={4} fill="url(#sky)" stroke="var(--window-frame)" strokeWidth={4} />
          <path d={`M${x + 48} 18 V${wall - 14}`} stroke="var(--window-frame)" strokeWidth={3} />
          <path d={`M${x} ${wall - 12} L${x - 30} ${wall + 120} L${x + 126} ${wall + 120} L${x + 96} ${wall - 12} Z`} fill="url(#sunbeam)" />
        </g>
      ))}
      <SkyDetails phase={daylight.phase} windows={windows} wall={wall} />
      <WallClock x={hall.x + hall.w / 2 + 160} y={wall / 2 + 2} hour={clock.hour} minute={clock.minute} />
      <Whiteboard x={hall.x + hall.w / 2 - 260} y={14} />

      {/* Chief of Staff's office */}
      <rect x={chiefRoom.x} y={chiefRoom.y} width={chiefRoom.w} height={chiefRoom.h} rx={10} fill="url(#carpet)" />
      <ellipse cx={chiefRoom.x + chiefRoom.w / 2} cy={chiefRoom.y + 214} rx={130} ry={46} fill={chiefColor} opacity={0.28} />
      <Bookshelf x={chiefRoom.x + 18} y={chiefRoom.y + 10} />
      <Plant x={chiefRoom.x + chiefRoom.w - 46} y={chiefRoom.y + 14} size={1.1} />
      <Armchair x={chiefRoom.x + 18} y={chiefRoom.y + chiefRoom.h - 54} />
      <GlassWalls room={chiefRoom} />
      <g className="room-sign">
        <rect x={chiefRoom.x + chiefRoom.w - 128} y={chiefRoom.y + chiefRoom.h - 30} width={112} height={20} rx={5} fill="var(--sign)" />
        <text x={chiefRoom.x + chiefRoom.w - 72} y={chiefRoom.y + chiefRoom.h - 16} textAnchor="middle" className="floor-label">
          Chief of Staff
        </text>
      </g>

      {/* Lounge and entrance */}
      <Lounge room={lounge} />
      <Door x={layout.door.x} y={height - 8} />

      {/* Pods */}
      {pods.map((pod) =>
        pod.supervisorId ? (
          <g key={pod.id}>
            <rect x={pod.x} y={pod.y} width={pod.w} height={pod.h} rx={16} fill={podColors[pod.id] ?? "#888"} opacity={0.16} />
            <rect x={pod.x + 1} y={pod.y + 1} width={pod.w - 2} height={pod.h - 2} rx={15} fill="none" stroke={podColors[pod.id] ?? "#888"} strokeOpacity={0.45} strokeWidth={2} />
            {pod.spareDesks.map((desk) => (
              <svg key={`${desk.x}-${desk.y}`} x={desk.x} y={desk.y} width={STATION.small.w} height={STATION.small.h} viewBox="0 0 160 150">
                <SpareDesk />
              </svg>
            ))}
          </g>
        ) : (
          <g key={pod.id} className="vacant-pod">
            <rect x={pod.x + 1} y={pod.y + 1} width={pod.w - 2} height={pod.h - 2} rx={15} fill="var(--vacant)" stroke="var(--vacant-line)" strokeWidth={2} strokeDasharray="10 8" />
            <circle cx={pod.x + pod.w / 2} cy={pod.y + pod.h / 2 - 12} r={18} fill="none" stroke="var(--vacant-line)" strokeWidth={2} />
            <path d={`M${pod.x + pod.w / 2 - 8} ${pod.y + pod.h / 2 - 12} h16 M${pod.x + pod.w / 2} ${pod.y + pod.h / 2 - 20} v16`} stroke="var(--vacant-line)" strokeWidth={2.4} strokeLinecap="round" />
            <text x={pod.x + pod.w / 2} y={pod.y + pod.h / 2 + 26} textAnchor="middle" className="floor-label vacant-label">
              Vacant pod
            </text>
          </g>
        ),
      )}

      {/* Meeting room */}
      <rect x={meetingRoom.x} y={meetingRoom.y} width={meetingRoom.w} height={meetingRoom.h} rx={12} fill="url(#carpet)" />
      <Plant x={meetingRoom.x + meetingRoom.w - 46} y={meetingRoom.y + 70} size={1} />
      <MeetingWalls room={meetingRoom} />
      <g className="room-sign">
        <rect x={meetingRoom.x + 16} y={meetingRoom.y + meetingRoom.h - 30} width={112} height={20} rx={5} fill="var(--sign)" />
        <text x={meetingRoom.x + 72} y={meetingRoom.y + meetingRoom.h - 16} textAnchor="middle" className="floor-label">
          Meeting room
        </text>
      </g>
    </svg>
  );
});

function windowSpots(width: number): number[] {
  const spots: number[] = [];
  for (let x = 70; x + 96 < width - 40; x += 190) spots.push(x);
  return spots;
}

function SkyDetails({ phase, windows, wall }: { phase: Daylight["phase"]; windows: number[]; wall: number }) {
  if (phase === "night") {
    return (
      <g fill="#fff">
        {windows.flatMap((x, index) =>
          [0, 1, 2].map((star) => (
            <circle key={`${x}-${star}`} className="star" cx={x + 12 + ((index * 23 + star * 31) % 72)} cy={22 + ((index * 7 + star * 11) % (wall - 40))} r={0.9 + (star % 2) * 0.5} opacity={0.8} />
          )),
        )}
        {windows[1] !== undefined && <circle cx={windows[1] + 72} cy={28} r={6} fill="#f4f1de" />}
      </g>
    );
  }
  if (phase === "day" && windows[2] !== undefined) {
    return (
      <g>
        <circle cx={windows[2] + 26} cy={28} r={7} fill="#fff1a8" />
        <ellipse cx={windows[0]! + 64} cy={34} rx={14} ry={4.5} fill="#fff" opacity={0.8} />
        {windows[3] !== undefined && <ellipse cx={windows[3] + 30} cy={26} rx={12} ry={4} fill="#fff" opacity={0.75} />}
      </g>
    );
  }
  return null;
}

function WallClock({ x, y, hour, minute }: { x: number; y: number; hour: number; minute: number }) {
  const minuteAngle = minute * 6;
  const hourAngle = (hour % 12) * 30 + minute * 0.5;
  return (
    <g className="wall-clock">
      <circle cx={x} cy={y} r={17} fill="#f8fafc" stroke="var(--window-frame)" strokeWidth={3} />
      {[0, 90, 180, 270].map((angle) => (
        <rect key={angle} x={x - 0.8} y={y - 15} width={1.6} height={3.5} fill="#475569" transform={`rotate(${angle} ${x} ${y})`} />
      ))}
      <path d={`M${x} ${y} V${y - 8.5}`} stroke="#1e293b" strokeWidth={2.2} strokeLinecap="round" transform={`rotate(${hourAngle} ${x} ${y})`} />
      <path d={`M${x} ${y} V${y - 12.5}`} stroke="#1e293b" strokeWidth={1.4} strokeLinecap="round" transform={`rotate(${minuteAngle} ${x} ${y})`} />
      <circle cx={x} cy={y} r={1.6} fill="#ef4444" />
    </g>
  );
}

function Whiteboard({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={120} height={36} rx={3} fill="#f8fafc" stroke="#94a3b8" strokeWidth={2} />
      <path d={`M${x + 10} ${y + 12} q12 -6 24 0 t24 0`} stroke="#3b82f6" strokeWidth={1.6} fill="none" />
      <path d={`M${x + 70} ${y + 9} h36 M${x + 70} ${y + 16} h28 M${x + 10} ${y + 25} h50`} stroke="#ef4444" strokeWidth={1.4} />
      <rect x={x + 92} y={y + 22} width={18} height={9} rx={1.5} fill="#fde68a" />
    </g>
  );
}

function Bookshelf({ x, y }: { x: number; y: number }) {
  const spines = ["#e2566e", "#4f7cff", "#f0a33a", "#2bb3a3", "#8a63d2", "#d4b13a", "#3c9d4e", "#e07a3f", "#5a6b7d", "#c94f9b", "#2e8fc7"];
  return (
    <g>
      <rect x={x} y={y} width={150} height={44} rx={4} fill="var(--wood-dark)" />
      <rect x={x + 4} y={y + 4} width={142} height={17} fill="var(--shelf-back)" />
      <rect x={x + 4} y={y + 24} width={142} height={16} fill="var(--shelf-back)" />
      {spines.map((color, index) => (
        <rect key={index} x={x + 7 + index * 12.5} y={y + 6 + (index % 3)} width={9} height={15 - (index % 3)} rx={1} fill={color} />
      ))}
      {spines.slice(0, 7).map((color, index) => (
        <rect key={`b${index}`} x={x + 9 + index * 19} y={y + 26 + (index % 2) * 2} width={12} height={12 - (index % 2) * 2} rx={1} fill={color} opacity={0.85} />
      ))}
    </g>
  );
}

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size})`} className="plant">
      <ellipse cx={16} cy={40} rx={16} ry={4} fill="#000" opacity={0.15} />
      <path d="M4 22 L28 22 L25 40 L7 40 Z" fill="#c7663f" />
      <rect x={3} y={20} width={26} height={5} rx={2} fill="#d97a50" />
      <g className="leaves" fill="#3f9a5a">
        <ellipse cx={10} cy={10} rx={5} ry={11} transform="rotate(-30 10 10)" />
        <ellipse cx={22} cy={10} rx={5} ry={11} transform="rotate(30 22 10)" />
        <ellipse cx={16} cy={5} rx={4.5} ry={12} fill="#4fb36b" />
      </g>
    </g>
  );
}

function Armchair({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={58} height={46} rx={12} fill="#7a5c99" />
      <rect x={x + 8} y={y + 10} width={42} height={30} rx={8} fill="#9576b8" />
      <rect x={x + 70} y={y + 14} width={30} height={30} rx={15} fill="var(--wood-dark)" />
      <rect x={x + 79} y={y + 18} width={10} height={10} rx={2} fill="#f8fafc" />
    </g>
  );
}

function GlassWalls({ room }: { room: Rect }) {
  const right = room.x + room.w;
  const bottom = room.y + room.h;
  const doorFrom = room.x + 70;
  const doorTo = room.x + 140;
  return (
    <g stroke="var(--glass)" strokeWidth={5} strokeLinecap="round">
      <path d={`M${right} ${room.y} V${bottom}`} />
      <path d={`M${room.x} ${bottom} H${doorFrom} M${doorTo} ${bottom} H${right}`} />
      <path d={`M${doorFrom} ${bottom} A70 70 0 0 1 ${doorTo} ${bottom}`} transform={`rotate(180 ${(doorFrom + doorTo) / 2} ${bottom})`} strokeWidth={1.4} strokeDasharray="4 4" fill="none" opacity={0.6} />
    </g>
  );
}

/** Glass on every side, with a doorway in the wall to the hall, toward its right end. */
function MeetingWalls({ room }: { room: Rect }) {
  const right = room.x + room.w;
  const bottom = room.y + room.h;
  const doorFrom = right - 150;
  const doorTo = right - 80;
  return (
    <g stroke="var(--glass)" strokeWidth={5} strokeLinecap="round" fill="none">
      <path d={`M${room.x} ${room.y} H${doorFrom} M${doorTo} ${room.y} H${right}`} />
      <path d={`M${room.x} ${room.y} V${bottom} M${right} ${room.y} V${bottom}`} opacity={0.7} />
      <path d={`M${doorFrom} ${room.y} A70 70 0 0 1 ${doorTo} ${room.y}`} strokeWidth={1.4} strokeDasharray="4 4" opacity={0.6} />
    </g>
  );
}

function Lounge({ room }: { room: Rect }) {
  const { x, y, w } = room;
  return (
    <g>
      {/* Coffee counter */}
      <rect x={x + 12} y={y + 12} width={w - 24} height={34} rx={6} fill="var(--wood-dark)" />
      <rect x={x + 12} y={y + 12} width={w - 24} height={6} rx={3} fill="#fff" opacity={0.15} />
      <g>
        <rect x={x + 26} y={y + 2} width={34} height={36} rx={5} fill="#3f4654" />
        <rect x={x + 31} y={y + 8} width={24} height={9} rx={2} fill="#7dd3fc" opacity={0.8} />
        <rect x={x + 36} y={y + 24} width={14} height={9} rx={2} fill="#f8fafc" />
        <path className="coffee-steam" d={`M${x + 43} ${y + 22} q-2 -4 0 -7`} stroke="#fff" strokeWidth={1.2} fill="none" opacity={0.6} />
      </g>
      <rect x={x + 76} y={y + 18} width={12} height={14} rx={2} fill="#ff8a65" />
      <rect x={x + 94} y={y + 18} width={12} height={14} rx={2} fill="#4cc9f0" />
      {/* Water cooler */}
      <g>
        <rect x={x + w - 64} y={y + 4} width={26} height={38} rx={4} fill="#e2e8f0" />
        <rect x={x + w - 60} y={y - 12} width={18} height={20} rx={6} fill="#7dd3fc" opacity={0.75} />
      </g>
      {/* Rug, couch, and table */}
      <g>
        <rect x={x + 18} y={y + 74} width={w - 36} height={124} rx={22} fill="#7a5c99" opacity={0.22} />
        <rect x={x + 30} y={y + 84} width={170} height={58} rx={16} fill="#3e7c8c" />
        <rect x={x + 42} y={y + 96} width={70} height={38} rx={10} fill="#4f97a8" />
        <rect x={x + 118} y={y + 96} width={70} height={38} rx={10} fill="#4f97a8" />
        <rect x={x + 60} y={y + 152} width={110} height={26} rx={8} fill="var(--wood-dark)" />
        <circle cx={x + 90} cy={y + 165} r={5} fill="#f8fafc" />
        <rect x={x + 120} y={y + 158} width={22} height={14} rx={2} fill="#fde68a" transform={`rotate(-8 ${x + 131} ${y + 165})`} />
      </g>
      {/* Bean bags */}
      <ellipse cx={x + w - 62} cy={y + 170} rx={22} ry={17} fill="#e2566e" opacity={0.85} />
      <ellipse cx={x + w - 66} cy={y + 165} rx={12} ry={8} fill="#fff" opacity={0.15} />
      <ellipse cx={x + w - 28} cy={y + 196} rx={18} ry={14} fill="#f0a33a" opacity={0.85} />
      <Plant x={x + w - 50} y={y + 92} size={1} />
      <text x={x + w - 14} y={y + room.h - 14} textAnchor="end" className="floor-label lounge-label">
        Lounge
      </text>
    </g>
  );
}

/** The entrance: an opening in the bottom wall, the door swung open, and a mat. */
function Door({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y - 2} width={80} height={12} fill="var(--floor)" />
      <rect x={x + 8} y={y - 30} width={64} height={22} rx={5} fill="#a3541f" opacity={0.7} />
      <path d={`M${x + 12} ${y - 22} h56 M${x + 12} ${y - 16} h56`} stroke="#000" strokeOpacity={0.15} strokeWidth={2} />
      <path d={`M${x + 80} ${y} A80 80 0 0 0 ${x} ${y - 80}`} stroke="var(--glass)" strokeWidth={1.4} strokeDasharray="4 5" fill="none" opacity={0.5} />
      <path d={`M${x} ${y} V${y - 80}`} stroke="var(--wall-trim)" strokeWidth={5} strokeLinecap="round" />
      <text x={x + 40} y={y - 38} textAnchor="middle" className="floor-label door-label">
        Entrance
      </text>
    </g>
  );
}
