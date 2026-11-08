import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Agent, Responsibility, StaffReader } from "@aihub/shared";
import { clip, errandOf, type Errand } from "../../lib/assignments.ts";
import { hashSeed, lookFor, type Look } from "../../lib/avatar.ts";
import { daylightAt, stockholmTime } from "../../lib/daylight.ts";
import { layoutOffice, STATION, type Seat } from "../../lib/layout.ts";
import { bubbleText, currentRun, openItemCounts, presenceOf, speechOf, type Presence } from "../../lib/presence.ts";
import { plainText } from "../../lib/markdown.ts";
import { readersInHand } from "../../lib/sources.ts";
import { doorOffset, walkerAt } from "../../lib/walk.ts";
import { ROLE_LABELS, STATE_LABELS, URGENCY_LABELS } from "../../format.ts";
import type { OfficeState } from "../../state.ts";
import { WalkingFigure } from "./Figure.tsx";
import { FloorPlan } from "./FloorPlan.tsx";
import { Workstation, type Cue } from "./Station.tsx";
import { QuestionThreads, useQuestionMoments, useReducedMotion, Visitor, type Answer, type Visit } from "./Visits.tsx";

interface OfficeFloorProps {
  state: OfficeState;
  now: number;
  onSelectAgent(agentId: string): void;
  onOpenChat(): void;
  onOpenInbox(responsibilityId?: string): void;
}

/** How long walking in or out of the door takes, in ms. Matches the CSS animations. */
const WALK_MS = 2200;
const MIN_SCALE = 0.55;
const MAX_SCALE = 1.35;

export function OfficeFloor({ state, now, onSelectAgent, onOpenChat, onOpenInbox }: OfficeFloorProps) {
  const supervisorLimit = state.office?.supervisorLimit ?? 4;
  const layout = useMemo(() => layoutOffice(state.agents, supervisorLimit), [state.agents, supervisorLimit]);
  const looks = useLooks(state.agents);
  const daylight = daylightAt(new Date(now));
  const local = stockholmTime(new Date(now));
  const dark = daylight.light < 0.45;

  const responsibilityOf = useMemo(() => {
    const map = new Map<string, Responsibility>();
    for (const responsibility of state.responsibilities) {
      if (responsibility.status === "active" || !map.has(responsibility.ownerId)) map.set(responsibility.ownerId, responsibility);
    }
    return map;
  }, [state.responsibilities]);
  const itemCounts = useMemo(() => openItemCounts(state.items), [state.items]);
  const pendingProposals =
    state.proposals.filter((proposal) => proposal.status === "pending").length + state.staffChanges.filter((change) => change.status === "pending").length;

  const podColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const pod of layout.pods) if (pod.supervisorId) colors[pod.id] = looks.get(pod.supervisorId)?.accent ?? "#888";
    return colors;
  }, [layout.pods, looks]);
  const chief = state.agents.find((agent) => agent.role === "chief_of_staff");

  // A toolsmith at work: whoever is writing a reader or has just handed one in, and which one.
  const authoring = useMemo(() => readersInHand(state.readers), [state.readers]);

  // Temporary workers wear a lanyard in their supervisor's color.
  const lanyards = useMemo(() => {
    const colors = new Map<string, string>();
    for (const agent of state.agents) {
      const color = agent.role === "worker" && agent.managerId ? looks.get(agent.managerId)?.accent : undefined;
      if (color) colors.set(agent.id, color);
    }
    return colors;
  }, [state.agents, looks]);

  const still = useReducedMotion();
  const seated = useMemo(() => new Set(layout.seats.map((seat) => seat.agentId)), [layout.seats]);
  const { visits, answers } = useQuestionMoments(state.assignments, seated, state.loaded, still);
  const { arriving, leaving } = useComings(state.agents, layout.seats, looks, lanyards, state.loaded);
  const { viewportRef, scale } = useFitScale(layout.width, layout.height);

  return (
    <section className="floor-viewport" aria-label="Office floor" ref={viewportRef}>
      <div className="floor-canvas" style={{ width: layout.width * scale, height: layout.height * scale }}>
        <div className={`floor-world phase-${daylight.phase}`} style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}>
          <FloorPlan
            layout={layout}
            daylight={daylight}
            podColors={podColors}
            chiefColor={chief ? (looks.get(chief.id)?.accent ?? "#888") : "#888"}
            clock={{ hour: Math.floor(local.hour), minute: Math.floor((local.hour % 1) * 60) }}
          />
          <div className="daylight" style={{ opacity: (1 - daylight.light) * 0.45 }} aria-hidden="true" />

          {layout.pods.map((pod) => {
            if (!pod.supervisorId) return null;
            const responsibility = responsibilityOf.get(pod.supervisorId);
            const counts = responsibility ? itemCounts.get(responsibility.id) : undefined;
            const owner = state.agents.find((agent) => agent.id === pod.supervisorId);
            const label = responsibility?.title ?? owner?.title ?? "Team pod";
            return (
              <div key={pod.id} className="pod-sign" style={{ left: pod.x + 12, top: pod.y + 8, maxWidth: pod.w - 24 }}>
                <span className="pod-title" title={responsibility?.scope}>
                  {label}
                  {responsibility?.status === "ended" && <span className="pod-ended"> · ended</span>}
                </span>
                {counts && counts.count > 0 && (
                  <button
                    type="button"
                    className={`pod-items urgency-${counts.top}`}
                    onClick={() => onOpenInbox(responsibility!.id)}
                    aria-label={`${counts.count} open item${counts.count === 1 ? "" : "s"} for ${label}, most pressing: ${URGENCY_LABELS[counts.top]}. Open the inbox.`}
                  >
                    {counts.count}
                    {counts.fresh > 0 && <span className="pod-items-new">new</span>}
                  </button>
                )}
              </div>
            );
          })}

          {layout.seats.map((seat) => {
            const agent = state.agents.find((candidate) => candidate.id === seat.agentId);
            const look = looks.get(seat.agentId);
            if (!agent || !look) return null;
            const presence = presenceOf(agent, state.runs, now);
            const run = currentRun(agent.id, state.runs);
            const speech = speechOf(agent.id, state.streaming, state.runs);
            const arrival = arriving.has(agent.id);
            const visit = visits.find((candidate) => candidate.askerId === agent.id) ?? null;
            const answer = answers.find((candidate) => candidate.ownerId === agent.id) ?? null;
            return (
              <StationButton
                key={agent.id}
                agent={agent}
                look={look}
                seat={seat}
                presence={presence}
                task={run?.title ?? null}
                errand={errandOf(agent.id, state.runs, state.assignments)}
                reader={authoring.get(agent.id) ?? null}
                visit={visit}
                speech={speech && !visit ? bubbleText(speech.text, seat.size === "small" ? 90 : 150) : null}
                answer={answer}
                lanyard={lanyards.get(agent.id)}
                dark={dark}
                arriving={arrival ? { dx: layout.door.x - seat.x, dy: layout.door.y - seat.y } : null}
                onSelect={() => onSelectAgent(agent.id)}
              />
            );
          })}

          {still && <QuestionThreads assignments={state.assignments} seats={layout.seats} width={layout.width} height={layout.height} />}

          {visits.map((visit) => {
            const from = layout.seats.find((seat) => seat.agentId === visit.askerId);
            const to = layout.seats.find((seat) => seat.agentId === visit.ownerId);
            const look = looks.get(visit.askerId);
            if (!from || !to || !look) return null;
            return <Visitor key={visit.id} visit={visit} look={look} from={from} to={to} lanyard={lanyards.get(visit.askerId)} />;
          })}

          {leaving.map((ghost) => {
            const box = walkerAt(ghost.seat);
            const { dx, dy } = doorOffset(ghost.seat, layout.door);
            return (
              <div
                key={`${ghost.agentId}-${ghost.since}`}
                className="walker leaving"
                style={{ left: box.left, top: box.top, width: box.width, height: box.height, "--to-x": `${dx}px`, "--to-y": `${dy}px` } as CSSProperties}
                aria-hidden="true"
              >
                <WalkingFigure look={ghost.look} lanyard={ghost.lanyard} />
              </div>
            );
          })}

          {chief && pendingProposals > 0 && (() => {
            const seat = layout.seats.find((candidate) => candidate.agentId === chief.id);
            // The speech bubble takes the same spot; the marker comes back when she's done talking.
            if (!seat || speechOf(chief.id, state.streaming, state.runs)) return null;
            return (
              <button type="button" className="quest-marker" style={{ left: seat.x + STATION.large.w / 2, top: seat.y - 26 }} onClick={onOpenChat}>
                <span className="quest-icon" aria-hidden="true">
                  !
                </span>
                {pendingProposals === 1 ? "A proposal awaits you" : `${pendingProposals} proposals await you`}
              </button>
            );
          })()}
        </div>
      </div>
    </section>
  );
}

interface StationButtonProps {
  agent: Agent;
  look: Look;
  seat: Seat;
  presence: Presence;
  task: string | null;
  /** What an assignment has them doing, if anything. */
  errand: Errand | null;
  /** The reader they are writing or just handed in, for a toolsmith at work. */
  reader: StaffReader | null;
  /** Over at a colleague's desk with a question. */
  visit: Visit | null;
  speech: string | null;
  /** An answer they just gave a colleague. */
  answer: Answer | null;
  lanyard?: string;
  dark: boolean;
  arriving: { dx: number; dy: number } | null;
  onSelect(): void;
}

const CUES: Record<Errand["kind"], Cue> = {
  answering: "answering",
  reviewing: null,
  waiting_on_team: "waiting_on_team",
  awaiting_answer: null,
};

/**
 * What the station says the person is doing: the run, or what an assignment has them doing. The
 * nameplate gets the short form; the label and tooltip get the whole line.
 */
function statusLine(presence: Presence, task: string | null, errand: Errand | null, visit: Visit | null, reader: StaffReader | null): { plate: string; full: string } | null {
  const line = (plate: string, detail?: string | null) => ({ plate, full: detail ? `${plate}: ${detail}` : plate });
  if (visit) return line(`Asking ${visit.ownerName}`, visit.title);
  if (!errand && reader) return line(reader.status === "drafting" ? `Writing the ${reader.name} reader` : `Handed in the ${reader.name} reader`);
  switch (errand?.kind) {
    case "answering":
      return line(`Answering ${errand.assignment.requesterName}`, errand.assignment.title);
    case "reviewing":
      return line("Reviewing", errand.assignment?.title ?? task);
    case "waiting_on_team": {
      const { total, settled } = errand.wait;
      const count = total > 0 ? ` · ${settled}/${total} in` : "";
      return { plate: `Waiting on team${count}`, full: `Waiting on the team${total > 0 ? `, ${settled} of ${total} in` : ""}: ${errand.wait.task.title}` };
    }
    case "awaiting_answer":
      return line(`Waiting for ${errand.assignment.ownerName}'s answer`, errand.assignment.title);
  }
  if (presence === "idle") return null;
  return line(STATE_LABELS[presence], task && presence !== "done" && presence !== "failed" ? task : null);
}

/** Ends text with a full stop unless it already ends a sentence, such as a question's title. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function StationButton({ agent, look, seat, presence, task, errand, reader, visit, speech, answer, lanyard, dark, arriving, onSelect }: StationButtonProps) {
  const size = STATION[seat.size];
  const line = statusLine(presence, task, errand, visit, reader);
  const status = line?.full ?? null;
  const answered = answer ? `Just answered ${answer.requesterName}. ` : "";
  const label = `${agent.name}, ${agent.title || ROLE_LABELS[agent.role]}${agent.role === "worker" ? ", temporary worker" : ""}. ${sentence(status ?? "Idle")} ${answered}Open profile.`;
  // A per-person offset so blinks and breaths don't run in step across the office.
  const style: CSSProperties & Record<string, string | number> = {
    left: seat.x,
    top: seat.y,
    width: size.w,
    height: size.h,
    "--delay": `-${hashSeed(agent.id) % 5000}ms`,
  };
  if (arriving) {
    style["--from-x"] = `${arriving.dx}px`;
    style["--from-y"] = `${arriving.dy}px`;
  }
  const bubble = speech ?? null;
  return (
    <button
      type="button"
      className={`station size-${seat.size} presence-${presence}${errand ? ` errand-${errand.kind}` : ""}${arriving ? " arriving" : ""}${bubble || answer ? " speaking" : ""}${visit ? " away" : ""}`}
      style={style}
      aria-label={label}
      title={`${agent.name} — ${status ?? "Idle"}`}
      onClick={onSelect}
    >
      <Workstation
        look={look}
        presence={presence}
        talking={bubble !== null || answer !== null}
        dark={dark}
        grand={seat.size === "large"}
        away={visit !== null}
        lanyard={lanyard}
        cue={(errand ? CUES[errand.kind] : null) ?? (reader ? "toolsmith" : null)}
      />
      <span className="nameplate" aria-hidden="true">
        <span className="nameplate-name">{agent.name}</span>
        {seat.size !== "small" && <span className="nameplate-line">{line?.plate ?? (agent.title || ROLE_LABELS[agent.role])}</span>}
      </span>
      {bubble ? (
        <span className="speech" aria-hidden="true">
          {bubble}
          <span className="caret" />
        </span>
      ) : (
        answer && (
          <span className="speech answer-bubble" aria-hidden="true">
            <span className="answer-to">To {answer.requesterName}</span>
            {clip(plainText(answer.text), seat.size === "small" ? 80 : 130)}
          </span>
        )
      )}
    </button>
  );
}

function useLooks(agents: Agent[]): Map<string, Look> {
  const cache = useRef(new Map<string, { seed: string; look: Look }>());
  return useMemo(() => {
    const looks = new Map<string, Look>();
    for (const agent of agents) {
      let entry = cache.current.get(agent.id);
      if (!entry || entry.seed !== agent.avatar) {
        entry = { seed: agent.avatar, look: lookFor(agent.avatar) };
        cache.current.set(agent.id, entry);
      }
      looks.set(agent.id, entry.look);
    }
    return looks;
  }, [agents]);
}

interface Ghost {
  agentId: string;
  look: Look;
  seat: Seat;
  lanyard?: string;
  since: number;
}

/**
 * Who is walking in or out. Staff on the roster when the office first loads are already seated;
 * anyone hired later walks in from the door, and anyone who leaves the roster, such as a worker
 * whose result was accepted, walks out to it.
 */
function useComings(agents: Agent[], seats: Seat[], looks: Map<string, Look>, lanyards: Map<string, string>, loaded: boolean) {
  const known = useRef<Map<string, Omit<Ghost, "agentId" | "since">> | null>(null);
  const [arriving, setArriving] = useState<Set<string>>(() => new Set());
  const [leaving, setLeaving] = useState<Ghost[]>([]);

  useEffect(() => {
    if (!loaded) return;
    const current = new Map<string, Omit<Ghost, "agentId" | "since">>();
    for (const seat of seats) {
      const look = looks.get(seat.agentId);
      if (look) current.set(seat.agentId, { look, seat, lanyard: lanyards.get(seat.agentId) });
    }
    const previous = known.current;
    known.current = current;
    if (!previous) return;
    const arrived = [...current.keys()].filter((id) => !previous.has(id));
    const left = [...previous.entries()].filter(([id]) => !current.has(id));
    const since = Date.now();
    if (arrived.length) {
      setArriving((set) => new Set([...set, ...arrived]));
      setTimeout(() => setArriving((set) => new Set([...set].filter((id) => !arrived.includes(id)))), WALK_MS);
    }
    if (left.length) {
      const ghosts = left.map(([agentId, entry]) => ({ agentId, ...entry, since }));
      setLeaving((list) => [...list, ...ghosts]);
      setTimeout(() => setLeaving((list) => list.filter((ghost) => !ghosts.includes(ghost))), WALK_MS);
    }
  }, [agents, seats, looks, lanyards, loaded]);

  return { arriving, leaving };
}

/** Scales the floor to fit its viewport, within limits; past the minimum, the viewport scrolls. */
function useFitScale(width: number, height: number) {
  const viewportRef = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fit = () => {
      const style = getComputedStyle(viewport);
      const availableW = viewport.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const availableH = viewport.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availableW / width, availableH / height)));
      setScale((current) => (Math.abs(current - next) < 0.005 ? current : next));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [width, height]);
  return { viewportRef, scale };
}

export type { Presence };
