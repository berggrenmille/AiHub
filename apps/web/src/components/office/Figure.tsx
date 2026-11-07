import type { ReactNode } from "react";
import { shade, type Look } from "../../lib/avatar.ts";

// A staff member drawn in SVG, in the workstation's 160 × 150 frame: head centred at (70, 44),
// shoulders at y 72, the desk edge at y 90. Original art: simple shapes, no outside assets.

export type Pose = "typing" | "rest" | "holding" | "clipboard" | "raised" | "slumped";

interface FigureProps {
  look: Look;
  pose: Pose;
  talking?: boolean;
  /** A worried mouth, for a failed run. */
  frown?: boolean;
  /** A visitor's lanyard in this color, for temporary workers. */
  lanyard?: string;
}

const HEAD = { x: 70, y: 44, r: 16 };
const INK = "#2a2230";

export function Figure({ look, pose, talking = false, frown = false, lanyard }: FigureProps) {
  return (
    <g className={`figure pose-${pose}`}>
      <g className="figure-body">
        <HairBack look={look} />
        <Torso look={look} />
        <rect x={65} y={55} width={10} height={12} rx={3} fill={look.skinShade} />
        <NeckAccessory look={look} />
        {lanyard && <Lanyard color={lanyard} />}
        {pose === "holding" && <Paper />}
        {pose === "clipboard" && <Clipboard />}
        <g className="figure-head">
          <circle cx={54} cy={46} r={3.6} fill={look.skinShade} />
          <circle cx={86} cy={46} r={3.6} fill={look.skinShade} />
          {look.accessory === "earrings" && (
            <>
              <circle cx={54} cy={51} r={1.6} fill={look.accent} />
              <circle cx={86} cy={51} r={1.6} fill={look.accent} />
            </>
          )}
          <circle cx={HEAD.x} cy={HEAD.y} r={HEAD.r} fill={look.skin} />
          <Face look={look} talking={talking} frown={frown} />
          <HairFront look={look} />
          <HeadAccessory look={look} />
        </g>
        <Arms look={look} pose={pose} />
      </g>
    </g>
  );
}

function Face({ look, talking, frown }: { look: Look; talking: boolean; frown: boolean }) {
  return (
    <g className="face">
      <circle cx={60} cy={50} r={2.6} fill="#ff7a8a" opacity={0.28} />
      <circle cx={80} cy={50} r={2.6} fill="#ff7a8a" opacity={0.28} />
      <path d="M61.5 41.2 Q64 40 66.5 41.2" stroke={shade(look.hair, 0.1)} strokeWidth={1.3} fill="none" strokeLinecap="round" />
      <path d="M73.5 41.2 Q76 40 78.5 41.2" stroke={shade(look.hair, 0.1)} strokeWidth={1.3} fill="none" strokeLinecap="round" />
      <g className="eyes">
        <ellipse cx={64} cy={46} rx={1.8} ry={2.2} fill={INK} />
        <ellipse cx={76} cy={46} rx={1.8} ry={2.2} fill={INK} />
        <circle cx={64.6} cy={45.2} r={0.6} fill="#fff" />
        <circle cx={76.6} cy={45.2} r={0.6} fill="#fff" />
      </g>
      {look.mark === "freckles" && (
        <g fill={shade(look.skin, 0.3)} opacity={0.7}>
          <circle cx={60} cy={48.6} r={0.55} />
          <circle cx={62} cy={49.8} r={0.55} />
          <circle cx={59.4} cy={50.6} r={0.55} />
          <circle cx={80} cy={48.6} r={0.55} />
          <circle cx={78} cy={49.8} r={0.55} />
          <circle cx={80.6} cy={50.6} r={0.55} />
        </g>
      )}
      {look.mark === "mole" && <circle cx={76.5} cy={53.5} r={0.8} fill={shade(look.skin, 0.45)} />}
      {talking ? (
        <ellipse className="mouth-talk" cx={70} cy={53.5} rx={2.6} ry={1.8} fill="#6b2f3a" />
      ) : frown ? (
        <path d="M66.5 54.5 Q70 51.8 73.5 54.5" stroke="#6b3a3a" strokeWidth={1.3} fill="none" strokeLinecap="round" />
      ) : (
        <path d="M66.5 52.4 Q70 55.6 73.5 52.4" stroke="#6b3a3a" strokeWidth={1.3} fill="none" strokeLinecap="round" />
      )}
    </g>
  );
}

function Torso({ look }: { look: Look }) {
  const { clothing, clothingShade, skin, accent } = look;
  let details: ReactNode = null;
  switch (look.outfit) {
    case "tee":
      details = <path d="M63 67 Q70 74.5 77 67 Z" fill={skin} />;
      break;
    case "collar":
      details = (
        <>
          <path d="M63 67 Q70 73 77 67 Z" fill={skin} />
          <path d="M61.5 66.5 L70 74 L65 78.5 Z" fill="#f6f7fb" />
          <path d="M78.5 66.5 L70 74 L75 78.5 Z" fill="#f6f7fb" />
          <circle cx={70} cy={84} r={0.9} fill={clothingShade} />
          <circle cx={70} cy={92} r={0.9} fill={clothingShade} />
        </>
      );
      break;
    case "hoodie":
      details = (
        <>
          <path d="M57 69 Q70 61 83 69 Q78 75.5 70 75.5 Q62 75.5 57 69 Z" fill={clothingShade} />
          <path d="M66.5 75 L66 86 M73.5 75 L74 86" stroke="#f1f1f1" strokeWidth={1} strokeLinecap="round" />
          <path d="M58 96 Q70 92 82 96" stroke={clothingShade} strokeWidth={1.5} fill="none" />
        </>
      );
      break;
    case "blazer":
      details = (
        <>
          <path d="M63.5 67 L70 80 L76.5 67 Z" fill="#f4f4f6" />
          <path d="M62 66.5 L70 83 L61 102 L55 80 Z" fill={clothingShade} />
          <path d="M78 66.5 L70 83 L79 102 L85 80 Z" fill={clothingShade} />
          <rect x={80} y={84} width={6} height={1.6} rx={0.8} fill={accent} opacity={0.9} />
        </>
      );
      break;
    case "sweater":
      details = (
        <>
          <path d="M62 67 Q70 73 78 67" stroke={clothingShade} strokeWidth={3} fill="none" strokeLinecap="round" />
          <path d="M51 88 L89 88" stroke={accent} strokeWidth={3} opacity={0.75} />
          <path d="M50.5 93 L89.5 93" stroke={accent} strokeWidth={1.4} opacity={0.6} />
        </>
      );
      break;
  }
  return (
    <g className="torso">
      <path d="M47 106 L49.5 80 Q51 68.5 62 67 L78 67 Q89 68.5 90.5 80 L93 106 Z" fill={clothing} />
      {details}
    </g>
  );
}

function Arms({ look, pose }: { look: Look; pose: Pose }) {
  const sleeve = { stroke: look.clothingShade, strokeWidth: 7, fill: "none", strokeLinecap: "round" as const };
  const hand = (cx: number, cy: number, className?: string) => <circle className={className} cx={cx} cy={cy} r={4} fill={look.skin} />;
  switch (pose) {
    case "typing":
      return (
        <g className="arms">
          <path d="M54 73 Q46 87 59 94" {...sleeve} />
          <path d="M86 73 Q94 87 81 94" {...sleeve} />
          <g className="hand hand-left">{hand(60, 94.5)}</g>
          <g className="hand hand-right">{hand(80, 94.5)}</g>
        </g>
      );
    case "holding":
    case "clipboard":
      return (
        <g className="arms">
          <path d="M54 73 Q45 86 58 86" {...sleeve} />
          <path d="M86 73 Q95 86 82 86" {...sleeve} />
          {hand(58.5, 85.5)}
          {hand(81.5, 85.5)}
        </g>
      );
    case "raised":
      return (
        <g className="arms">
          <path d="M54 73 Q46 87 57 95" {...sleeve} />
          {hand(58, 95.5)}
          <g className="raised-arm">
            <path d="M86 73 Q97 62 96 42" {...sleeve} />
            {hand(96, 38)}
          </g>
        </g>
      );
    case "slumped":
      return (
        <g className="arms">
          <path d="M54 75 Q50 90 62 95" {...sleeve} />
          <path d="M86 75 Q90 90 78 95" {...sleeve} />
          {hand(63, 95.5)}
          {hand(77, 95.5)}
        </g>
      );
    case "rest":
    default:
      return (
        <g className="arms">
          <path d="M54 73 Q47 88 55 96" {...sleeve} />
          <path d="M86 73 Q93 88 85 96" {...sleeve} />
          {hand(55.5, 96.5)}
          {hand(84.5, 96.5)}
        </g>
      );
  }
}

/** A temporary worker's badge on a strap, in its supervisor's color. */
function Lanyard({ color }: { color: string }) {
  return (
    <g className="lanyard">
      <path d="M62.5 67.5 L67 79 M77.5 67.5 L73 79" stroke={color} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      <rect x={65} y={78} width={10} height={11.5} rx={1.6} fill="#f8fafc" stroke={color} strokeWidth={0.9} />
      <rect x={65} y={78} width={10} height={3.2} rx={1.2} fill={color} />
      <path d="M67.2 84.5 H72.8 M67.2 86.8 H71" stroke="#94a3b8" strokeWidth={0.8} strokeLinecap="round" />
    </g>
  );
}

function Paper() {
  return (
    <g className="held-paper">
      <rect x={56} y={68} width={28} height={20} rx={1.5} fill="#fbfbf7" stroke="#d6d3c4" strokeWidth={0.6} />
      <path d="M60 73 H80 M60 76.5 H78 M60 80 H80 M60 83.5 H72" stroke="#9aa3b2" strokeWidth={0.9} />
    </g>
  );
}

function Clipboard() {
  return (
    <g className="held-clipboard">
      <rect x={57} y={67} width={26} height={21} rx={2} fill="#9a6b40" />
      <rect x={59} y={69.5} width={22} height={17} rx={1} fill="#fbfbf7" />
      <rect x={66} y={65.5} width={8} height={4} rx={1} fill="#6b7280" />
      <path d="M61 73.5 l1.5 1.5 l3 -3 M61 79 l1.5 1.5 l3 -3" stroke="#22a35a" strokeWidth={1.1} fill="none" />
      <path d="M68 74 H78 M68 79.5 H76 M68 84 H78" stroke="#9aa3b2" strokeWidth={0.9} />
    </g>
  );
}

function HairBack({ look }: { look: Look }) {
  const fill = look.hair;
  switch (look.hairStyle) {
    case "bob":
      return <path d="M51 46 C49 27 60 22.5 70 22.5 C80 22.5 91 27 89 46 L90 61 Q86 64 82 61 L58 61 Q54 64 50 61 Z" fill={shade(fill, 0.08)} />;
    case "long":
      return <path d="M50 46 C48 25 60 21.5 70 21.5 C80 21.5 92 25 90 46 L94 86 Q70 92 46 86 Z" fill={shade(fill, 0.1)} />;
    case "ponytail":
      return <path d="M84 34 Q101 40 96 70 Q93 72 91 69 Q94 52 82 42 Z" fill={shade(fill, 0.06)} />;
    case "afro":
      return <circle cx={70} cy={39} r={24} fill={fill} />;
    case "bun":
      return (
        <>
          <circle cx={70} cy={23.5} r={7.5} fill={fill} />
          <rect x={64.5} y={28} width={11} height={2.6} rx={1.3} fill={look.accent} />
        </>
      );
    default:
      return null;
  }
}

function HairFront({ look }: { look: Look }) {
  const fill = look.hair;
  const shine = <path d="M60 31 Q66 27.5 73 28" stroke="#fff" strokeOpacity={0.22} strokeWidth={1.6} fill="none" strokeLinecap="round" />;
  switch (look.hairStyle) {
    case "short":
      return (
        <g>
          <path d="M54 46 C52 30 62 25 71 25 C81 25 89 31 86 46 C84 39 80 35 74 34 C68 37 60 37 56.5 40.5 C55.4 42 54.6 44 54 46 Z" fill={fill} />
          {shine}
        </g>
      );
    case "buzz":
      return <path d="M54.5 42 C55 31 63 27 70 27 C78 27 85 31 85.5 42 C80 36.5 75 34.5 70 34.5 C65 34.5 59.5 36.5 54.5 42 Z" fill={fill} opacity={0.85} />;
    case "bob":
      return (
        <g>
          <path d="M54 44 C53 31 61 26 70 26 C79 26 87 31 86 44 C83 38.5 78 36.5 73 36.5 L70 33.5 L67 36.5 C62 36.5 57 38.5 54 44 Z" fill={fill} />
          <path d="M54.5 40 Q52 52 54.5 60 L58 60 Q56.5 50 57.5 42 Z" fill={fill} />
          <path d="M85.5 40 Q88 52 85.5 60 L82 60 Q83.5 50 82.5 42 Z" fill={fill} />
          {shine}
        </g>
      );
    case "long":
      return (
        <g>
          <path d="M54 44 C53 30 61 25 70 25 C79 25 87 30 86 44 C80 36 74 32.5 70 31.5 C66 32.5 60 36 54 44 Z" fill={fill} />
          <path d="M54.5 40 Q50 60 53 82 L59 82 Q56.5 60 57.5 44 Z" fill={fill} />
          <path d="M85.5 40 Q90 60 87 82 L81 82 Q83.5 60 82.5 44 Z" fill={fill} />
          {shine}
        </g>
      );
    case "bun":
      return <path d="M54.5 43 C54.5 31 62 27 70 27 C78 27 85.5 31 85.5 43 C81 37 76 35 70 35 C64 35 59 37 54.5 43 Z" fill={fill} />;
    case "curly": {
      const curls: Array<[number, number, number]> = [
        [55, 40, 5.4],
        [58, 33, 5.8],
        [64, 28.5, 6],
        [71, 27, 6.2],
        [78, 29, 6],
        [83.5, 34, 5.8],
        [86, 41, 5.2],
        [61, 36, 4.2],
        [70, 34, 4.4],
        [79, 36, 4.2],
      ];
      return (
        <g fill={fill}>
          {curls.map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      );
    }
    case "ponytail":
      return (
        <g>
          <path d="M54 44 C53 30 61 25.5 70 25.5 C79 25.5 87 30 86 44 C83 37.5 78 34.5 70 34.5 C62 34.5 57 37.5 54 44 Z" fill={fill} />
          <circle cx={86.5} cy={38} r={2} fill={look.accent} />
          {shine}
        </g>
      );
    case "spiky":
      return <path d="M54 44 L54.5 33 L59 36 L60.5 25.5 L65 31.5 L69 22.5 L72.5 31 L77.5 24.5 L79 33 L84.5 28.5 L85 37 L86 44 C82 38 76 35 70 35 C63 35 58 38 54 44 Z" fill={fill} />;
    case "afro":
      return <path d="M54 42 C56 33 63 30 70 30 C77 30 84 33 86 42 C80 37.5 75 36.5 70 36.5 C65 36.5 60 37.5 54 42 Z" fill={shade(fill, 0.1)} />;
    case "sidepart":
      return (
        <g>
          <path d="M54 46 C52 30 62 24.5 72 24.5 C82 24.5 89 31 86 46 C85 40 82.5 36.5 78.5 35 C71 38.5 61 40.5 54 46 Z" fill={fill} />
          <path d="M62 30 Q70 33 78.5 35" stroke={shade(fill, 0.25)} strokeWidth={0.9} fill="none" />
          {shine}
        </g>
      );
    case "bald":
      return (
        <g>
          <path d="M54.3 40 Q53.2 47 55.5 51 L57 43 Z" fill={fill} />
          <path d="M85.7 40 Q86.8 47 84.5 51 L83 43 Z" fill={fill} />
          <ellipse cx={63} cy={33} rx={4.5} ry={2.4} fill="#fff" opacity={0.25} transform="rotate(-25 63 33)" />
        </g>
      );
  }
}

function HeadAccessory({ look }: { look: Look }) {
  switch (look.accessory) {
    case "round_glasses":
      return (
        <g stroke="#1f2430" strokeWidth={1.25} fill="#ffffff" fillOpacity={0.14}>
          <circle cx={64} cy={46} r={4.3} />
          <circle cx={76} cy={46} r={4.3} />
          <path d="M68.3 45.6 Q70 44.6 71.7 45.6" fill="none" />
        </g>
      );
    case "square_glasses":
      return (
        <g stroke="#1f2430" strokeWidth={1.3} fill="#ffffff" fillOpacity={0.14}>
          <rect x={59.3} y={42.6} width={9.2} height={7} rx={1.6} />
          <rect x={71.5} y={42.6} width={9.2} height={7} rx={1.6} />
          <path d="M68.5 45.4 H71.5" fill="none" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path d="M52.5 46 C50 22 90 22 87.5 46" stroke="#2d3340" strokeWidth={3.2} fill="none" strokeLinecap="round" />
          <rect x={48.5} y={40} width={7} height={12} rx={2.6} fill={look.accent} />
          <rect x={84.5} y={40} width={7} height={12} rx={2.6} fill={look.accent} />
        </g>
      );
    case "beanie":
      return (
        <g>
          <path d="M53 40 C52.5 22 87.5 22 87 40 Z" fill={look.accent} />
          <rect x={52} y={35.5} width={36} height={6.5} rx={3.2} fill={shade(look.accent, 0.2)} />
          <circle cx={70} cy={22.5} r={3.6} fill={shade(look.accent, 0.1)} />
        </g>
      );
    case "hairclip":
      return <rect x={77} y={30} width={7} height={3} rx={1.5} fill={look.accent} transform="rotate(-20 80.5 31.5)" />;
    default:
      return null;
  }
}

function NeckAccessory({ look }: { look: Look }) {
  switch (look.accessory) {
    case "tie":
      return <path d="M68 68 L72 68 L73.2 72 L71.4 88 L70 90.5 L68.6 88 L66.8 72 Z" fill={look.accent} />;
    case "scarf":
      return (
        <g fill={look.accent}>
          <path d="M57.5 65.5 Q70 74 82.5 65.5 L83.5 71 Q70 80 56.5 71 Z" />
          <path d="M74.5 72.5 L79.5 88 L74 88.5 L71.5 74 Z" fill={shade(look.accent, 0.12)} />
        </g>
      );
    default:
      return null;
  }
}

/**
 * A staff member on their feet, walking out or over to a colleague: the seated figure with legs,
 * in an 80 × 124 frame (viewBox 30 10 80 124) with the head centred at (40, 34).
 */
export function WalkingFigure({ look, lanyard }: { look: Look; lanyard?: string }) {
  const trousers = shade(look.clothingShade, 0.35);
  return (
    <svg className="walking-figure" viewBox="30 10 80 124" width="100%" height="100%" aria-hidden="true" focusable="false">
      <ellipse cx={70} cy={130} rx={17} ry={3.4} fill="#000" opacity={0.22} />
      <g className="leg leg-left">
        <rect x={57.5} y={98} width={10} height={27} rx={4} fill={trousers} />
        <ellipse cx={61.5} cy={126} rx={6.4} ry={3.2} fill="#232833" />
      </g>
      <g className="leg leg-right">
        <rect x={72.5} y={98} width={10} height={27} rx={4} fill={trousers} />
        <ellipse cx={78.5} cy={126} rx={6.4} ry={3.2} fill="#232833" />
      </g>
      <Figure look={look} pose="rest" lanyard={lanyard} />
    </svg>
  );
}

/** A head-and-shoulders portrait for profile cards and lists. */
export function Portrait({ look, size = 96, label, animated = true }: { look: Look; size?: number; label?: string; animated?: boolean }) {
  return (
    <svg
      className={`portrait${animated ? " portrait-animated" : ""}`}
      viewBox="38 14 64 64"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx={70} cy={46} r={31} fill={look.accent} opacity={0.22} />
      <Figure look={look} pose="rest" />
    </svg>
  );
}
