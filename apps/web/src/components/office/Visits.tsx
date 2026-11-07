import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { Assignment, AssignmentStatus } from "@aihub/shared";
import type { Look } from "../../lib/avatar.ts";
import { clip, openQuestions } from "../../lib/assignments.ts";
import { STATION, type Seat } from "../../lib/layout.ts";
import { visitOffset, walkerAt } from "../../lib/walk.ts";
import { WalkingFigure } from "./Figure.tsx";

// Asking a colleague, on the floor (DESIGN.md › The office experience): the asker walks over to the
// colleague's desk, asks, and walks back; the answer pops up on the colleague when it's in. With
// reduced motion nobody walks: a dashed line joins the two desks while the question is open.

/** Walking one way, in ms. Matches the `visit-out` and `visit-back` animations. */
export const VISIT_WALK_MS = 1800;
/** Standing at the colleague's desk with the question. */
export const VISIT_STAY_MS = 4600;
/** How long an answer stays up on the colleague who gave it. */
export const ANSWER_MS = 7000;

export interface Visit {
  /** The question's assignment ID. */
  id: string;
  askerId: string;
  ownerId: string;
  ownerName: string;
  title: string;
  phase: "out" | "there" | "back";
}

export interface Answer {
  assignmentId: string;
  ownerId: string;
  requesterName: string;
  text: string;
}

/** True when the operator's system asks for less motion. Follows changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchesReducedMotion());
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function matchesReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

/** Runs visits one at a time per asker, and the timers behind visits and answers. */
class Choreographer {
  private readonly queue: Visit[] = [];
  private readonly walking = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly setVisits: Dispatch<SetStateAction<Visit[]>>,
    private readonly setAnswers: Dispatch<SetStateAction<Answer[]>>,
  ) {}

  visit(visit: Visit) {
    this.queue.push(visit);
    this.next(visit.askerId);
  }

  answer(answer: Answer) {
    // A newer answer from the same colleague replaces the one on show.
    this.setAnswers((list) => [...list.filter((other) => other.ownerId !== answer.ownerId), answer]);
    this.later(ANSWER_MS, () => this.setAnswers((list) => list.filter((other) => other !== answer)));
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue.length = 0;
    this.walking.clear();
  }

  private next(askerId: string) {
    if (this.walking.has(askerId)) return;
    const index = this.queue.findIndex((visit) => visit.askerId === askerId);
    if (index === -1) return;
    const [visit] = this.queue.splice(index, 1) as [Visit];
    this.walking.add(askerId);
    this.setVisits((list) => [...list, visit]);
    const phase = (next: Visit["phase"]) => this.setVisits((list) => list.map((other) => (other.id === visit.id ? { ...other, phase: next } : other)));
    this.later(VISIT_WALK_MS, () => phase("there"));
    this.later(VISIT_WALK_MS + VISIT_STAY_MS, () => phase("back"));
    this.later(2 * VISIT_WALK_MS + VISIT_STAY_MS, () => {
      this.setVisits((list) => list.filter((other) => other.id !== visit.id));
      this.walking.delete(askerId);
      this.next(askerId);
    });
  }

  private later(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }
}

/**
 * Who is over at a colleague's desk and which answers are showing, from changes to the
 * assignments. Questions already open when the office loads don't send anyone walking.
 */
export function useQuestionMoments(assignments: Assignment[], seated: ReadonlySet<string>, loaded: boolean, still: boolean) {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [choreographer] = useState(() => new Choreographer(setVisits, setAnswers));
  const known = useRef<Map<string, AssignmentStatus> | null>(null);

  useEffect(() => () => choreographer.stop(), [choreographer]);

  // Runs again when seats change too; with the same assignments it finds nothing new.
  useEffect(() => {
    if (!loaded) return;
    const previous = known.current;
    known.current = new Map(assignments.map((assignment) => [assignment.id, assignment.status]));
    if (!previous) return;
    // Several changes can land in one render. Play them in the order they happened.
    const oldestFirst = [...assignments].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.createdAt.localeCompare(b.createdAt));
    for (const assignment of oldestFirst) {
      if (assignment.kind !== "question") continue;
      const before = previous.get(assignment.id);
      if (before === undefined && assignment.status === "open" && !still && seated.has(assignment.requesterId) && seated.has(assignment.ownerId)) {
        choreographer.visit({
          id: assignment.id,
          askerId: assignment.requesterId,
          ownerId: assignment.ownerId,
          ownerName: assignment.ownerName,
          title: assignment.title,
          phase: "out",
        });
      }
      if (assignment.status === "delivered" && before !== undefined && before !== "delivered" && assignment.result) {
        choreographer.answer({ assignmentId: assignment.id, ownerId: assignment.ownerId, requesterName: assignment.requesterName, text: assignment.result });
      }
    }
  }, [assignments, seated, loaded, still, choreographer]);

  return { visits, answers };
}

/** The asker on their way to a colleague's desk, standing there with the question, or on the way back. */
export function Visitor({ visit, look, from, to, lanyard }: { visit: Visit; look: Look; from: Seat; to: Seat; lanyard?: string }) {
  const box = walkerAt(from);
  const { dx, dy } = visitOffset(from, to);
  const style = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    "--dx": `${dx}px`,
    "--dy": `${dy}px`,
  } as CSSProperties;
  return (
    <div className={`visitor phase-${visit.phase}${visit.phase === "there" ? "" : " walking"}`} style={style} aria-hidden="true">
      <WalkingFigure look={look} lanyard={lanyard} />
      {visit.phase === "there" && (
        <span className="speech visit-bubble">
          <span className="ask-mark">?</span>
          <span>{clip(visit.title, 70)}</span>
        </span>
      )}
    </div>
  );
}

/**
 * With reduced motion: a dashed line between asker and colleague while a question is open, with a
 * question mark on both desks. Decorative; the stations' labels say the same in words.
 */
export function QuestionThreads({ assignments, seats, width, height }: { assignments: Assignment[]; seats: Seat[]; width: number; height: number }) {
  const anchor = (seat: Seat) => ({ x: seat.x + STATION[seat.size].w * 0.44, y: seat.y + 6 });
  const threads = openQuestions(assignments).flatMap((question) => {
    const from = seats.find((seat) => seat.agentId === question.requesterId);
    const to = seats.find((seat) => seat.agentId === question.ownerId);
    return from && to && from !== to ? [{ id: question.id, a: anchor(from), b: anchor(to) }] : [];
  });
  if (threads.length === 0) return null;
  return (
    <svg className="question-threads" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      {threads.map(({ id, a, b }) => (
        <g key={id}>
          <path d={`M${a.x} ${a.y} Q${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - 60} ${b.x} ${b.y}`} className="thread-line" />
          {[a, b].map((point, index) => (
            <g key={index} transform={`translate(${point.x} ${point.y})`}>
              <circle r={11} className="thread-end" />
              <text y={4.5} textAnchor="middle" className="thread-mark">
                ?
              </text>
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}
