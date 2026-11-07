import { STATE_LABELS, toneOf, type AgentState } from "../format.ts";

export function StateBadge({ state }: { state: AgentState }) {
  return <span className={`badge tone-${toneOf(state)}`}>{STATE_LABELS[state]}</span>;
}
