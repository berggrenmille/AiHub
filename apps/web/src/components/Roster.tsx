import type { CSSProperties } from "react";
import type { Agent } from "@aihub/shared";
import { ROLE_LABELS } from "../format.ts";
import { StateBadge } from "./StateBadge.tsx";

interface RosterProps {
  entries: Array<{ agent: Agent; depth: number }>;
  selectedId: string | null;
  onSelect(agentId: string): void;
}

export function Roster({ entries, selectedId, onSelect }: RosterProps) {
  return (
    <nav className="panel roster" aria-labelledby="roster-title">
      <h2 className="panel-title" id="roster-title">
        Staff <span className="count">{entries.length}</span>
      </h2>
      <ul className="panel-body roster-list">
        {entries.map(({ agent, depth }) => (
          <li key={agent.id}>
            <button
              type="button"
              className="roster-item"
              style={{ "--depth": depth } as CSSProperties}
              aria-current={agent.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(agent.id)}
            >
              <span className="agent-name">{agent.name}</span>
              <span className="agent-role">{ROLE_LABELS[agent.role]}</span>
              <StateBadge state={agent.state} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
