import { useMemo, useState, type KeyboardEvent } from "react";
import type { Agent, NoteSummary } from "@aihub/shared";
import { lookFor } from "../lib/avatar.ts";
import { forceLayout } from "../lib/graph.ts";
import { noteGraph } from "../lib/notes.ts";

// The vault's graph: every note a dot, every resolved [[wikilink]] a line, colored by folder.

interface NoteGraphProps {
  notes: NoteSummary[];
  agents: Agent[];
  currentPath: string | null;
  onOpen(path: string): void;
}

const WIDTH = 800;
const HEIGHT = 540;

export function NoteGraph({ notes, agents, currentPath, onOpen }: NoteGraphProps) {
  const [journals, setJournals] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const graph = useMemo(() => noteGraph(notes, { journals }), [notes, journals]);
  const positions = useMemo(
    () => forceLayout(graph.nodes.map((node) => node.id), graph.edges, { width: WIDTH, height: HEIGHT, padding: 40 }),
    [graph],
  );
  const colors = useMemo(() => {
    const map = new Map<string | null, string>([[null, "var(--accent)"]]);
    for (const agent of agents) map.set(agent.id, lookFor(agent.avatar).accent);
    return map;
  }, [agents]);
  const focus = hovered ?? currentPath;
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!focus) return set;
    for (const edge of graph.edges) {
      if (edge.source === focus) set.add(edge.target);
      if (edge.target === focus) set.add(edge.source);
    }
    return set;
  }, [graph.edges, focus]);

  const onKey = (event: KeyboardEvent, path: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(path);
    }
  };

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <label className="toggle">
          <input type="checkbox" checked={journals} onChange={(event) => setJournals(event.target.checked)} /> Show journal days
        </label>
        <ul className="graph-legend" aria-label="Folders">
          <li>
            <span className="swatch" style={{ background: "var(--accent)" }} /> Office
          </li>
          {agents.map((agent) => (
            <li key={agent.id}>
              <span className="swatch" style={{ background: colors.get(agent.id) }} /> {agent.name}
            </li>
          ))}
        </ul>
      </div>
      {graph.nodes.length === 0 ? (
        <p className="empty">No notes to draw yet.</p>
      ) : (
        <svg className="graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label={`Notes graph: ${graph.nodes.length} notes, ${graph.edges.length} links`}>
          <g className="graph-edges">
            {graph.edges.map((edge) => {
              const a = positions.get(edge.source);
              const b = positions.get(edge.target);
              if (!a || !b) return null;
              const lit = focus !== null && (edge.source === focus || edge.target === focus);
              return <line key={`${edge.source}>${edge.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={lit ? "lit" : focus ? "dim" : undefined} />;
            })}
          </g>
          <g className="graph-nodes">
            {graph.nodes.map((node) => {
              const point = positions.get(node.id);
              if (!point) return null;
              const radius = 5 + Math.sqrt(node.degree) * 3 + (node.kind === "profile" ? 2 : 0);
              const state = node.id === currentPath ? "current" : focus && (node.id === focus || neighbours.has(node.id)) ? "lit" : focus ? "dim" : "";
              return (
                <g
                  key={node.id}
                  className={`graph-node kind-${node.kind} ${state}`}
                  transform={`translate(${point.x} ${point.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.title}, ${node.degree} link${node.degree === 1 ? "" : "s"}. Open.`}
                  onClick={() => onOpen(node.id)}
                  onKeyDown={(event) => onKey(event, node.id)}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(node.id)}
                  onBlur={() => setHovered(null)}
                >
                  <circle r={radius + 6} className="hit" />
                  <circle r={radius} fill={colors.get(node.ownerId) ?? "var(--muted)"} />
                  <text y={radius + 13} textAnchor="middle">
                    {node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
