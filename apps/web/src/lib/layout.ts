// Where everyone sits on the office floor (DESIGN.md › The office experience): the Chief of Staff in
// a permanent office, a team pod per supervisor, workers at their supervisor's pod, a lounge, and
// the door. Positions are in floor units; the floor scales to fit the screen.

import type { Agent } from "@aihub/shared";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SeatSize = "large" | "medium" | "small";

export interface Seat {
  agentId: string;
  /** Top-left of the workstation. */
  x: number;
  y: number;
  size: SeatSize;
  /** The pod the seat belongs to, or null for the Chief of Staff's office and hot desks. */
  podId: string | null;
}

export interface Pod extends Rect {
  id: string;
  /** Null for a vacant pod, kept for the next supervisor. */
  supervisorId: string | null;
  /** Empty worker desks to draw, as top-left corners. */
  spareDesks: Array<{ x: number; y: number }>;
}

export interface OfficeLayout {
  width: number;
  height: number;
  /** The band along the top wall with the windows. */
  wall: number;
  chiefRoom: Rect;
  lounge: Rect;
  hall: Rect;
  door: { x: number; y: number };
  pods: Pod[];
  seats: Seat[];
}

/** Workstation sizes in floor units: a desk, its chair, and the person at it. */
export const STATION: Record<SeatSize, { w: number; h: number }> = {
  large: { w: 184, h: 172 },
  medium: { w: 160, h: 150 },
  small: { w: 100, h: 94 },
};

export const FLOOR_WIDTH = 1280;
const WALL = 64;
const LEFT_WING = 330;
const GAP = 18;
const MARGIN = 20;
const POD_TOP = 34;
const WORKER_ROW = STATION.small.h + 26;
const MAX_POD_SLOTS = 12;
const WORKERS_PER_ROW = 2;

const byHire = (a: Agent, b: Agent) => a.hiredAt.localeCompare(b.hiredAt) || a.id.localeCompare(b.id);

export function layoutOffice(agents: Agent[], supervisorLimit: number): OfficeLayout {
  const chiefs = agents.filter((agent) => agent.role === "chief_of_staff").sort(byHire);
  const supervisors = agents.filter((agent) => agent.role === "supervisor").sort(byHire);
  const workers = agents.filter((agent) => agent.role === "worker").sort(byHire);
  const supervisorIds = new Set(supervisors.map((agent) => agent.id));

  const team = new Map<string, Agent[]>();
  const hotDesk: Agent[] = [...chiefs.slice(1)];
  for (const worker of workers) {
    if (worker.managerId && supervisorIds.has(worker.managerId)) team.set(worker.managerId, [...(team.get(worker.managerId) ?? []), worker]);
    else hotDesk.push(worker);
  }

  const slots = Math.max(supervisors.length, Math.min(Math.max(supervisorLimit, 1), MAX_POD_SLOTS));
  const columns = slots > 6 ? 4 : 3;
  const rows = Math.ceil(slots / columns);
  const hall: Rect = { x: LEFT_WING + GAP, y: WALL + MARGIN, w: FLOOR_WIDTH - LEFT_WING - GAP - MARGIN, h: 0 };
  const podW = Math.floor((hall.w - GAP * (columns - 1)) / columns);
  const workerRows = Math.max(1, ...supervisors.map((supervisor) => Math.ceil((team.get(supervisor.id)?.length ?? 0) / WORKERS_PER_ROW)));
  const podH = POD_TOP + STATION.medium.h + 8 + workerRows * WORKER_ROW;
  hall.h = rows * podH + (rows - 1) * GAP;

  const chiefRoom: Rect = { x: MARGIN, y: WALL + MARGIN, w: LEFT_WING - MARGIN, h: 330 };
  const loungeTop = chiefRoom.y + chiefRoom.h + GAP;
  const hotDeskRows = Math.ceil(hotDesk.length / 2);
  const loungeH = Math.max(280, hotDeskRows * WORKER_ROW + 220);
  const height = Math.max(hall.y + hall.h + MARGIN + 30, loungeTop + loungeH + MARGIN);
  const lounge: Rect = { x: MARGIN, y: loungeTop, w: LEFT_WING - MARGIN, h: height - loungeTop - MARGIN };
  const door = { x: MARGIN + 40, y: height - MARGIN };

  const seats: Seat[] = [];
  const chief = chiefs[0];
  if (chief) {
    seats.push({
      agentId: chief.id,
      x: chiefRoom.x + (chiefRoom.w - STATION.large.w) / 2,
      y: chiefRoom.y + 92,
      size: "large",
      podId: null,
    });
  }

  const pods: Pod[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const supervisor = supervisors[slot] ?? null;
    const pod: Pod = {
      id: supervisor ? `pod-${supervisor.id}` : `vacant-${slot}`,
      supervisorId: supervisor?.id ?? null,
      x: hall.x + column * (podW + GAP),
      y: hall.y + row * (podH + GAP),
      w: podW,
      h: podH,
      spareDesks: [],
    };
    pods.push(pod);
    if (!supervisor) continue;
    seats.push({ agentId: supervisor.id, x: pod.x + (pod.w - STATION.medium.w) / 2, y: pod.y + POD_TOP, size: "medium", podId: pod.id });
    const members = team.get(supervisor.id) ?? [];
    const desks = Math.max(WORKERS_PER_ROW, Math.ceil(members.length / WORKERS_PER_ROW) * WORKERS_PER_ROW);
    const deskGap = Math.max(4, Math.min(24, pod.w - WORKERS_PER_ROW * STATION.small.w - 8));
    const rowW = WORKERS_PER_ROW * STATION.small.w + (WORKERS_PER_ROW - 1) * deskGap;
    for (let desk = 0; desk < desks; desk++) {
      const x = pod.x + (pod.w - rowW) / 2 + (desk % WORKERS_PER_ROW) * (STATION.small.w + deskGap);
      const y = pod.y + POD_TOP + STATION.medium.h + 8 + Math.floor(desk / WORKERS_PER_ROW) * WORKER_ROW;
      const member = members[desk];
      if (member) seats.push({ agentId: member.id, x, y, size: "small", podId: pod.id });
      else pod.spareDesks.push({ x, y });
    }
  }

  // Hot desks in the lounge for anyone without a pod, such as a worker whose supervisor left.
  hotDesk.forEach((agent, index) => {
    seats.push({
      agentId: agent.id,
      x: lounge.x + 24 + (index % 2) * (STATION.small.w + 30),
      y: lounge.y + 190 + Math.floor(index / 2) * WORKER_ROW,
      size: "small",
      podId: null,
    });
  });

  return { width: FLOOR_WIDTH, height, wall: WALL, chiefRoom, lounge, hall, door, pods, seats };
}
