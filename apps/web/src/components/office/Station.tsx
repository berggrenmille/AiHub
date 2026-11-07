import { useId } from "react";
import type { Look } from "../../lib/avatar.ts";
import type { Presence } from "../../lib/presence.ts";
import { Figure, type Pose } from "./Figure.tsx";

// A workstation in its 160 × 150 frame: chair, the person, desk, keyboard, monitor, mug, and a
// badge for the run state. CSS animates it by the `presence-*` class on the parent.

const POSES: Record<Presence, Pose> = {
  idle: "rest",
  queued: "rest",
  collecting: "holding",
  working: "typing",
  reviewing: "clipboard",
  waiting_for_access: "rest",
  waiting_for_approval: "raised",
  done: "rest",
  failed: "slumped",
};

const SCREENS: Record<Presence, string> = {
  idle: "#33465c",
  queued: "#4a5d78",
  collecting: "#9ee6b8",
  working: "#8fd3ff",
  reviewing: "#c9b8ff",
  waiting_for_access: "#ffcf70",
  waiting_for_approval: "#ffb36b",
  done: "#8ff0b0",
  failed: "#ff7b7b",
};

interface WorkstationProps {
  look: Look;
  presence: Presence;
  talking: boolean;
  /** Lamps come on when the office is dark. */
  dark: boolean;
  /** The Chief of Staff's desk gets a plant and a second screen. */
  grand?: boolean;
}

export function Workstation({ look, presence, talking, dark, grand = false }: WorkstationProps) {
  const id = useId().replace(/:/g, "");
  const screen = SCREENS[presence];
  const lit = presence !== "idle" && presence !== "waiting_for_access";
  return (
    <svg className="workstation" viewBox="0 0 160 150" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`glow-${id}`}>
          <stop offset="0%" stopColor={screen} stopOpacity={0.55} />
          <stop offset="100%" stopColor={screen} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`lamp-${id}`}>
          <stop offset="0%" stopColor="#ffd98a" stopOpacity={0.55} />
          <stop offset="100%" stopColor="#ffd98a" stopOpacity={0} />
        </radialGradient>
        <clipPath id={`screen-${id}`}>
          <rect x={102.5} y={56.5} width={35} height={23} rx={1.5} />
        </clipPath>
      </defs>

      <ellipse cx={80} cy={142} rx={72} ry={6} fill="#000" opacity={0.18} />
      {dark && <ellipse className="lamp-pool" cx={40} cy={96} rx={46} ry={26} fill={`url(#lamp-${id})`} />}
      {lit && <ellipse className="screen-glow" cx={112} cy={70} rx={46} ry={38} fill={`url(#glow-${id})`} />}

      {/* Chair back */}
      <rect x={45} y={46} width={50} height={56} rx={12} fill="var(--chair)" />
      <rect x={49} y={50} width={42} height={48} rx={10} fill="var(--chair-hi)" opacity={0.5} />

      {/* A little larger than the frame's grid, pivoting at the desk edge, so faces read at a glance. */}
      <g transform="translate(70 92) scale(1.14) translate(-70 -92)">
        <Figure look={look} pose={POSES[presence]} talking={talking} frown={presence === "failed"} />
        {lit && <circle cx={70} cy={44} r={16} fill={screen} opacity={0.1} className="face-glow" />}
      </g>

      {/* Desk */}
      <rect x={6} y={90} width={148} height={15} rx={3} fill="var(--desk-top)" />
      <rect x={6} y={90} width={148} height={2.5} rx={1.2} fill="#fff" opacity={0.18} />
      <rect x={6} y={104} width={148} height={34} rx={3} fill="var(--desk-front)" />
      <rect x={110} y={112} width={36} height={20} rx={2} fill="#000" opacity={0.08} />
      <rect x={124} y={121} width={8} height={2} rx={1} fill="#000" opacity={0.25} />

      {/* Hands go back on top of the desk edge while typing */}
      {POSES[presence] === "typing" && <TypingHands look={look} />}

      {/* Keyboard */}
      <rect x={55} y={93} width={30} height={5.5} rx={1.3} fill="#e7ebf1" stroke="#aeb6c3" strokeWidth={0.5} />
      <path d="M58 95 H82 M58 96.8 H82" stroke="#b9c1cd" strokeWidth={0.6} strokeDasharray="1.6 0.8" />

      {/* Lamp */}
      <g>
        <rect x={12} y={88} width={12} height={3} rx={1.5} fill="#5b6472" />
        <path d="M18 88 L22 74 L30 70" stroke="#5b6472" strokeWidth={1.8} fill="none" strokeLinecap="round" />
        <path d="M26 66 L36 70 L31 75 Z" fill={dark ? "#ffd98a" : "#7b8494"} />
      </g>

      {/* Mug */}
      <g className="mug">
        <rect x={36} y={82} width={10} height={10} rx={2} fill={look.accent} />
        <path d="M46 84.5 Q50.5 86.5 46 89.5" stroke={look.accent} strokeWidth={1.8} fill="none" />
        {presence === "idle" && (
          <g className="steam" stroke="#fff" strokeWidth={1} fill="none" strokeLinecap="round" opacity={0.7}>
            <path d="M39 79 q-1.6 -3 0 -5.5 q1.6 -2.5 0 -5" />
            <path d="M43 79 q-1.6 -3 0 -5.5 q1.6 -2.5 0 -5" />
          </g>
        )}
      </g>

      {(presence === "collecting" || presence === "reviewing") && (
        <g className="paper-stack">
          <rect x={14} y={92} width={18} height={4} rx={0.6} fill="#f3f1e7" transform="rotate(-4 23 94)" />
          <rect x={15} y={90} width={18} height={4} rx={0.6} fill="#fbfbf7" transform="rotate(3 24 92)" />
        </g>
      )}

      {grand && (
        <g>
          <rect x={140} y={80} width={10} height={11} rx={2} fill="#b0643f" />
          <path d="M145 80 Q138 70 141 64 M145 80 Q146 68 150 62 M145 80 Q152 72 154 70" stroke="#3f9a5a" strokeWidth={2.4} fill="none" strokeLinecap="round" />
        </g>
      )}

      {/* Monitor, turned toward its owner */}
      <g transform="translate(0 16.9) skewY(-8)">
        <rect x={116} y={78} width={6} height={12} fill="#596273" />
        <ellipse cx={119} cy={90.5} rx={9} ry={1.8} fill="#596273" />
        <rect x={100} y={54} width={40} height={28} rx={3} fill="#232833" />
        <rect className="screen" x={102.5} y={56.5} width={35} height={23} rx={1.5} fill={screen} opacity={lit ? 1 : 0.85} />
        <g clipPath={`url(#screen-${id})`}>
          <ScreenContent presence={presence} />
        </g>
      </g>

      <Badge presence={presence} />
    </svg>
  );
}

function TypingHands({ look }: { look: Look }) {
  return (
    <g>
      <g className="hand hand-left">
        <circle cx={58.6} cy={94.9} r={4.5} fill={look.skin} />
      </g>
      <g className="hand hand-right">
        <circle cx={81.4} cy={94.9} r={4.5} fill={look.skin} />
      </g>
    </g>
  );
}

function ScreenContent({ presence }: { presence: Presence }) {
  const ink = "#0e1726";
  switch (presence) {
    case "working":
      return (
        <g className="code-scroll" stroke={ink} strokeOpacity={0.55} strokeWidth={1.4} strokeLinecap="round">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((line) => (
            <path key={line} d={`M${105 + (line % 3) * 3} ${60 + line * 4} h${12 + ((line * 7) % 15)}`} />
          ))}
        </g>
      );
    case "collecting":
      return (
        <g fill={ink} fillOpacity={0.45}>
          <rect x={105} y={60} width={12} height={8} rx={1} />
          <rect x={120} y={60} width={14} height={2} rx={1} />
          <rect x={120} y={64} width={10} height={2} rx={1} />
          <rect x={105} y={71} width={29} height={2} rx={1} />
          <rect className="progress" x={105} y={75} width={29} height={2.4} rx={1.2} />
        </g>
      );
    case "reviewing":
      return (
        <g stroke={ink} strokeOpacity={0.6} strokeWidth={1.3} fill="none" strokeLinecap="round">
          <path d="M106 62 l1.6 1.6 l3 -3 M106 68 l1.6 1.6 l3 -3 M106 74 l1.6 1.6 l3 -3" />
          <path d="M114 62.5 h17 M114 68.5 h13 M114 74.5 h15" />
        </g>
      );
    case "waiting_for_access":
      return (
        <g fill={ink} fillOpacity={0.6}>
          <rect x={115} y={66} width={10} height={8} rx={1.4} />
          <path d="M116.8 66 v-2.5 a3.2 3.2 0 0 1 6.4 0 v2.5" stroke={ink} strokeOpacity={0.6} strokeWidth={1.4} fill="none" />
        </g>
      );
    case "waiting_for_approval":
      return (
        <g fill={ink} fillOpacity={0.65}>
          <rect x={118.6} y={60} width={2.8} height={10} rx={1.2} />
          <circle cx={120} cy={74} r={1.6} />
        </g>
      );
    case "failed":
      return <path d="M115 62 l10 12 M125 62 l-10 12" stroke={ink} strokeOpacity={0.6} strokeWidth={2} strokeLinecap="round" />;
    case "done":
      return <path d="M113 68 l4.5 4.5 l9 -9" stroke={ink} strokeOpacity={0.6} strokeWidth={2.2} fill="none" strokeLinecap="round" />;
    case "queued":
      return (
        <g fill={ink} fillOpacity={0.5}>
          <circle className="dot dot-1" cx={114} cy={68} r={1.6} />
          <circle className="dot dot-2" cx={120} cy={68} r={1.6} />
          <circle className="dot dot-3" cx={126} cy={68} r={1.6} />
        </g>
      );
    default:
      return (
        <g fill="#fff" fillOpacity={0.12}>
          <circle cx={120} cy={68} r={5} />
        </g>
      );
  }
}

function Badge({ presence }: { presence: Presence }) {
  switch (presence) {
    case "queued":
      return (
        <g className="art-badge art-badge-thought">
          <circle cx={86} cy={28} r={1.8} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={0.6} />
          <circle cx={91} cy={22} r={2.8} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={0.6} />
          <ellipse cx={106} cy={12} rx={14} ry={9.5} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={0.8} />
          <circle className="dot dot-1" cx={100} cy={12} r={1.7} fill="#64748b" />
          <circle className="dot dot-2" cx={106} cy={12} r={1.7} fill="#64748b" />
          <circle className="dot dot-3" cx={112} cy={12} r={1.7} fill="#64748b" />
        </g>
      );
    case "waiting_for_access":
      return (
        <g className="art-badge art-badge-pop">
          <circle cx={102} cy={20} r={10} fill="#f59e0b" stroke="#fff" strokeWidth={1.5} />
          <path d="M98.6 19.5 v-2.6 a3.4 3.4 0 0 1 6.8 0 v2.6" stroke="#fff" strokeWidth={1.8} fill="none" />
          <rect x={96.8} y={19} width={10.4} height={7.4} rx={1.6} fill="#fff" />
          <circle cx={102} cy={22.4} r={1.2} fill="#f59e0b" />
        </g>
      );
    case "waiting_for_approval":
      return (
        <g className="art-badge art-badge-pulse">
          <circle cx={112} cy={22} r={9} fill="#f97316" stroke="#fff" strokeWidth={1.5} />
          <rect x={110.7} y={16} width={2.6} height={8} rx={1.2} fill="#fff" />
          <circle cx={112} cy={27} r={1.5} fill="#fff" />
        </g>
      );
    case "done":
      return (
        <g className="art-badge art-badge-pop">
          <circle cx={102} cy={20} r={10} fill="#22c55e" stroke="#fff" strokeWidth={1.5} />
          <path d="M97 20.2 l3.4 3.4 l6 -6.6" stroke="#fff" strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    case "failed":
      return (
        <g className="art-badge art-badge-pop">
          <path d="M102 9 L113 28 L91 28 Z" fill="#ef4444" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
          <rect x={100.8} y={15} width={2.4} height={7} rx={1.1} fill="#fff" />
          <circle cx={102} cy={25} r={1.3} fill="#fff" />
        </g>
      );
    case "reviewing":
      return (
        <g className="art-badge art-badge-bob">
          <circle cx={104} cy={18} r={6} fill="none" stroke="#8b5cf6" strokeWidth={2.4} />
          <path d="M108.3 22.3 l5 5" stroke="#8b5cf6" strokeWidth={3} strokeLinecap="round" />
        </g>
      );
    default:
      return null;
  }
}

/** An empty desk waiting for a worker. */
export function SpareDesk() {
  return (
    <g className="spare-desk" opacity={0.75}>
      <ellipse cx={80} cy={142} rx={72} ry={6} fill="#000" opacity={0.12} />
      <rect x={47} y={50} width={46} height={52} rx={11} fill="var(--chair)" opacity={0.7} />
      <rect x={6} y={90} width={148} height={15} rx={3} fill="var(--desk-top)" />
      <rect x={6} y={104} width={148} height={34} rx={3} fill="var(--desk-front)" />
      <g transform="translate(0 16.9) skewY(-8)">
        <rect x={116} y={78} width={6} height={12} fill="#596273" />
        <rect x={100} y={54} width={40} height={28} rx={3} fill="#232833" />
        <rect x={102.5} y={56.5} width={35} height={23} rx={1.5} fill="#2b3442" />
      </g>
    </g>
  );
}
