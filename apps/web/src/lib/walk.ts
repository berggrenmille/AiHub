// Where a standing character goes on the floor: out of its chair, to a colleague's desk, and to the
// door. Positions are in floor units, like the layout.

import { STATION, type Seat } from "./layout.ts";

/** The standing figure's frame: an 80 × 124 box with the head centred at (40, 34). */
export const WALKER = { w: 80, h: 124, headX: 40, headY: 34 } as const;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

/** A seated head's centre: the workstation draws it at (70, 37) in its 160-wide frame. */
function headOf(seat: Seat): { x: number; y: number; scale: number } {
  const scale = STATION[seat.size].w / 160;
  return { x: seat.x + 70 * scale, y: seat.y + 37 * scale, scale };
}

/** How big someone looks on their feet. Workers at small desks still read as people. */
function walkerScale(seat: Seat): number {
  return Math.max(0.72, STATION[seat.size].w / 160) * 0.92;
}

/** The standing figure where the seated one was, so getting up doesn't jump. */
export function walkerAt(seat: Seat): Box {
  const head = headOf(seat);
  const scale = walkerScale(seat);
  return {
    left: head.x - WALKER.headX * scale,
    top: head.y - WALKER.headY * scale,
    width: WALKER.w * scale,
    height: WALKER.h * scale,
    scale,
  };
}

/**
 * How far to walk from one's own desk to stand beside a colleague's, on the side one comes from,
 * a little taller than the seated colleague.
 */
export function visitOffset(from: Seat, to: Seat): { dx: number; dy: number } {
  const start = walkerAt(from);
  const asker = headOf(from);
  const owner = headOf(to);
  const width = STATION[to.size].w;
  const fromLeft = asker.x <= owner.x;
  const centreX = fromLeft ? to.x - 12 * start.scale : to.x + width + 12 * start.scale;
  const headY = owner.y - 8 * start.scale;
  return {
    dx: centreX - WALKER.headX * start.scale - start.left,
    dy: headY - WALKER.headY * start.scale - start.top,
  };
}

/** How far to walk from one's desk out through the door. */
export function doorOffset(seat: Seat, door: { x: number; y: number }): { dx: number; dy: number } {
  const start = walkerAt(seat);
  return {
    dx: door.x + 40 - WALKER.headX * start.scale - start.left,
    dy: door.y - 12 - WALKER.h * start.scale - start.top,
  };
}
