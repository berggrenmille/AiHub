// A small force-directed layout for the notes graph (Fruchterman–Reingold with gravity). It is
// deterministic: the same nodes and edges always land in the same place, so the graph doesn't
// jump around when a note changes elsewhere.

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  iterations?: number;
  /** Space kept free along the edges. */
  padding?: number;
}

export function forceLayout(
  nodeIds: readonly string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  { width, height, iterations = 300, padding = 24 }: LayoutOptions,
): Map<string, Point> {
  const count = nodeIds.length;
  const positions = new Map<string, Point>();
  if (count === 0) return positions;
  const cx = width / 2;
  const cy = height / 2;
  if (count === 1) {
    positions.set(nodeIds[0]!, { x: cx, y: cy });
    return positions;
  }

  // Start on a sunflower spiral, in a stable order, so the result doesn't depend on chance.
  const order = [...nodeIds].sort();
  const index = new Map(order.map((id, i) => [id, i]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.min(width, height) / 2 - padding;
  for (let i = 0; i < count; i++) {
    const radius = spread * Math.sqrt((i + 0.5) / count);
    xs[i] = cx + radius * Math.cos(i * golden);
    ys[i] = cy + radius * Math.sin(i * golden);
  }
  const links: Array<[number, number]> = [];
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }

  const area = (width - 2 * padding) * (height - 2 * padding);
  const k = Math.sqrt(area / count) * 0.6;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  let temperature = Math.min(width, height) / 8;
  const cooling = temperature / (iterations + 1);

  for (let step = 0; step < iterations; step++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let ddx = xs[i]! - xs[j]!;
        let ddy = ys[i]! - ys[j]!;
        let distance = Math.hypot(ddx, ddy);
        if (distance < 0.01) {
          // Two nodes on the same spot: nudge them apart along a fixed direction.
          ddx = 0.01 * (i - j);
          ddy = 0.01;
          distance = Math.hypot(ddx, ddy);
        }
        const force = (k * k) / distance;
        dx[i]! += (ddx / distance) * force;
        dy[i]! += (ddy / distance) * force;
        dx[j]! -= (ddx / distance) * force;
        dy[j]! -= (ddy / distance) * force;
      }
    }
    for (const [a, b] of links) {
      const ddx = xs[a]! - xs[b]!;
      const ddy = ys[a]! - ys[b]!;
      const distance = Math.max(0.01, Math.hypot(ddx, ddy));
      const force = (distance * distance) / k;
      dx[a]! -= (ddx / distance) * force;
      dy[a]! -= (ddy / distance) * force;
      dx[b]! += (ddx / distance) * force;
      dy[b]! += (ddy / distance) * force;
    }
    for (let i = 0; i < count; i++) {
      // Gravity keeps unlinked notes from drifting to the walls.
      dx[i]! += (cx - xs[i]!) * 0.05 * k * 0.1;
      dy[i]! += (cy - ys[i]!) * 0.05 * k * 0.1;
      const displacement = Math.hypot(dx[i]!, dy[i]!);
      if (displacement > 0) {
        const limited = Math.min(displacement, temperature);
        xs[i] = clamp(xs[i]! + (dx[i]! / displacement) * limited, padding, width - padding);
        ys[i] = clamp(ys[i]! + (dy[i]! / displacement) * limited, padding, height - padding);
      }
    }
    temperature = Math.max(0.5, temperature - cooling);
  }

  for (let i = 0; i < count; i++) positions.set(order[i]!, { x: Math.round(xs[i]! * 10) / 10, y: Math.round(ys[i]! * 10) / 10 });
  return positions;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
