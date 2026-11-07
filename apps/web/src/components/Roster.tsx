import type { CSSProperties } from "react";
import type { Agent, Run } from "@aihub/shared";
import { lookFor } from "../lib/avatar.ts";
import { levelOf } from "../lib/level.ts";
import { presenceOf } from "../lib/presence.ts";
import { ROLE_LABELS } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";
import { StateBadge } from "./StateBadge.tsx";

// The roster as a compact list beside the office (DESIGN.md › The office experience).

interface RosterProps {
  entries: Array<{ agent: Agent; depth: number }>;
  runs: Record<string, Run>;
  now: number;
  selectedId: string | null;
  onSelect(agentId: string): void;
  onClose(): void;
}

export function Roster({ entries, runs, now, selectedId, onSelect, onClose }: RosterProps) {
  return (
    <nav className="side-panel roster" aria-labelledby="roster-title">
      <header className="side-head">
        <h2 id="roster-title">
          Staff <span className="count-badge">{entries.length}</span>
        </h2>
        <button type="button" className="icon-button" onClick={onClose} title="Hide the staff list">
          <Icon name="close" size={16} />
          <span className="visually-hidden">Hide the staff list</span>
        </button>
      </header>
      <ul className="roster-list">
        {entries.map(({ agent, depth }) => (
          <li key={agent.id}>
            <button
              type="button"
              className="roster-item"
              style={{ "--depth": depth } as CSSProperties}
              aria-current={agent.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(agent.id)}
            >
              <Portrait look={lookFor(agent.avatar)} size={34} animated={false} />
              <span className="roster-text">
                <span className="agent-name">
                  {agent.name} <span className="level-mini">Lv {levelOf(agent.experience).level}</span>
                </span>
                <span className="agent-role">{agent.title || ROLE_LABELS[agent.role]}</span>
              </span>
              <StateBadge state={presenceOf(agent, runs, now)} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
