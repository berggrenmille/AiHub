import { useId, useMemo, useState } from "react";
import type { Agent, Assignment } from "@aihub/shared";
import { assignmentTree, hasOpenWork, isOpenAssignment, openAssignmentCount, type AssignmentNode } from "../lib/assignments.ts";
import { lookFor } from "../lib/avatar.ts";
import { ASSIGNMENT_KIND_LABELS, ASSIGNMENT_STATUS_LABELS, assignmentTone, formatAgo, formatDateTime } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Portrait } from "./office/Figure.tsx";

// Questions and tasks between staff (DESIGN.md › Recruitment and delegation, Asking colleagues):
// one card per assignment, a list for a profile, and the office-wide tree in a drawer.

interface CardProps {
  assignment: Assignment;
  agents: Agent[];
  now: number;
  /** The staff member whose profile shows the card: named, not linked. */
  viewerId?: string;
  /** Show the owner's portrait: who works on it. */
  withOwner?: boolean;
  /** The title's heading level, below the list's own heading. */
  level?: 3 | 4;
  onSelectAgent(agentId: string): void;
}

export function AssignmentCard({ assignment, agents, now, viewerId, withOwner = false, level = 4, onSelectAgent }: CardProps) {
  const titleId = useId();
  const kind = ASSIGNMENT_KIND_LABELS[assignment.kind];
  const owner = agents.find((agent) => agent.id === assignment.ownerId) ?? null;
  const open = isOpenAssignment(assignment);
  const since = open ? assignment.createdAt : assignment.updatedAt;
  const Heading = level === 3 ? "h3" : "h4";
  return (
    <article className={`assignment-card kind-${assignment.kind} status-${assignment.status}`} aria-labelledby={titleId}>
      <div className="assignment-top">
        {withOwner ? (
          <span className="assignment-owner" aria-hidden="true">
            {owner ? <Portrait look={lookFor(owner.avatar)} size={34} animated={false} /> : <span className="portrait-gone">{assignment.ownerName.slice(0, 1)}</span>}
            <span className={`kind-icon kind-${assignment.kind}`}>
              <Icon name={assignment.kind === "question" ? "question" : "task"} size={13} />
            </span>
          </span>
        ) : (
          <span className={`kind-icon kind-${assignment.kind}`} aria-hidden="true">
            <Icon name={assignment.kind === "question" ? "question" : "task"} size={15} />
          </span>
        )}
        <div className="assignment-main">
          <Heading id={titleId} className="assignment-title">
            <span className="visually-hidden">{kind}: </span>
            {assignment.title}
          </Heading>
          <p className="assignment-meta">
            <Person id={assignment.requesterId} name={assignment.requesterName} agents={agents} viewerId={viewerId} onSelect={onSelectAgent} />
            <span aria-hidden="true"> → </span>
            <span className="visually-hidden"> {assignment.kind === "question" ? "asked" : "handed this to"} </span>
            <Person id={assignment.ownerId} name={assignment.ownerName} agents={agents} viewerId={viewerId} onSelect={onSelectAgent} />
          </p>
        </div>
        <span className={`badge tone-${assignmentTone(assignment.status)}`}>{ASSIGNMENT_STATUS_LABELS[assignment.status]}</span>
      </div>
      <p className="assignment-facts">
        <span className="runs" title="Runs used of the assignment's budget">
          <RunMeter used={assignment.runsUsed} budget={assignment.runBudget} />
          {assignment.runsUsed}/{assignment.runBudget} runs
        </span>
        <time dateTime={since} title={formatDateTime(since)}>
          {open ? (assignment.kind === "question" ? "Asked" : "Assigned") : ASSIGNMENT_STATUS_LABELS[assignment.status]} {formatAgo(since, now)}
        </time>
      </p>
      <details className="assignment-more">
        <summary>{detailsLabel(assignment)}</summary>
        <div className="assignment-body">
          <section aria-label={assignment.kind === "question" ? "The question" : "The brief"}>
            <p className="eyebrow">{assignment.kind === "question" ? "The question" : "The brief"}</p>
            {assignment.brief.trim() ? <p className="assignment-brief">{assignment.brief}</p> : <p className="muted small">No brief.</p>}
          </section>
          {assignment.result && (
            <section aria-label={assignment.kind === "question" ? "The answer" : "The result"}>
              <p className="eyebrow">{assignment.kind === "question" ? "The answer" : "The result"}</p>
              <Markdown source={assignment.result} className="assignment-result" />
            </section>
          )}
          {assignment.review && (
            <section aria-label="The review">
              <p className="eyebrow">Review by {assignment.requesterName}</p>
              <Markdown source={assignment.review} className="assignment-review" />
            </section>
          )}
        </div>
      </details>
    </article>
  );
}

function detailsLabel(assignment: Assignment): string {
  const parts = [assignment.kind === "question" ? "question" : "brief"];
  if (assignment.result) parts.push(assignment.kind === "question" ? "answer" : "result");
  if (assignment.review) parts.push("review");
  const text = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `The ${text}`;
}

function RunMeter({ used, budget }: { used: number; budget: number }) {
  const fraction = budget > 0 ? Math.min(1, used / budget) : 0;
  return (
    <span className={`run-meter${fraction >= 1 ? " spent" : ""}`} aria-hidden="true">
      <span style={{ width: `${fraction * 100}%` }} />
    </span>
  );
}

/** A name that opens the profile, plain for the profile it's on, and marked for staff who have left. */
function Person({ id, name, agents, viewerId, onSelect }: { id: string; name: string; agents: Agent[]; viewerId?: string; onSelect(agentId: string): void }) {
  const agent = agents.find((candidate) => candidate.id === id);
  if (id === viewerId) return <strong className="person-name">{agent?.name ?? name}</strong>;
  if (!agent) {
    return (
      <span className="person-name gone" title={`${name} has left the office`}>
        {name} <span className="muted">(left)</span>
      </span>
    );
  }
  return (
    <button type="button" className="person-name link-button" onClick={() => onSelect(agent.id)} title={`Open ${agent.name}'s profile`}>
      {agent.name}
    </button>
  );
}

/** How many settled assignments a profile shows before "Show more". */
const PROFILE_SETTLED = 5;

/** A staff member's assignments on its profile: open ones, then recent ones. */
export function AssignmentList({ assignments, agents, agentId, now, onSelectAgent }: { assignments: Assignment[]; agents: Agent[]; agentId: string; now: number; onSelectAgent(agentId: string): void }) {
  const [all, setAll] = useState(false);
  const open = assignments.filter(isOpenAssignment);
  const settled = assignments.filter((assignment) => !isOpenAssignment(assignment));
  const shown = [...open, ...(all ? settled : settled.slice(0, PROFILE_SETTLED))];
  const hidden = settled.length - (all ? settled.length : Math.min(settled.length, PROFILE_SETTLED));
  return (
    <>
      <ul className="assignment-list">
        {shown.map((assignment) => (
          <li key={assignment.id}>
            <AssignmentCard assignment={assignment} agents={agents} now={now} viewerId={agentId} onSelectAgent={onSelectAgent} />
          </li>
        ))}
      </ul>
      {(hidden > 0 || all) && settled.length > PROFILE_SETTLED && (
        <button type="button" className="button ghost small" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show fewer" : `Show ${hidden} more`}
        </button>
      )}
    </>
  );
}

interface DrawerProps {
  assignments: Assignment[];
  agents: Agent[];
  now: number;
  onSelectAgent(agentId: string): void;
  onClose(): void;
}

/** Every assignment in the office as a tree: a task, and under it the work handed out for it. */
export function AssignmentsDrawer({ assignments, agents, now, onSelectAgent, onClose }: DrawerProps) {
  const open = openAssignmentCount(assignments);
  const [filter, setFilter] = useState<"open" | "all">(() => (open > 0 ? "open" : "all"));
  const tree = useMemo(() => assignmentTree(assignments), [assignments]);
  const shown = filter === "open" ? tree.filter(hasOpenWork) : tree;
  return (
    <aside className="drawer assignments-drawer" aria-labelledby="assignments-title">
      <header className="drawer-head">
        <span className="drawer-icon" aria-hidden="true">
          <Icon name="task" size={20} />
        </span>
        <div className="drawer-title">
          <h2 id="assignments-title">Assignments</h2>
          <p className="muted small">Questions and tasks between staff, and who works on what</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Close the assignments">
          <Icon name="close" />
          <span className="visually-hidden">Close the assignments</span>
        </button>
      </header>
      <div className="drawer-toolbar filter-chips" role="group" aria-label="Which assignments">
        <button type="button" className="chip" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
          Open <span className="chip-count">{open}</span>
        </button>
        <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All <span className="chip-count">{assignments.length}</span>
        </button>
      </div>
      <div className="drawer-body">
        {shown.length === 0 ? (
          <div className="empty-state">
            <Icon name="task" size={28} />
            <p>
              {assignments.length === 0
                ? "No assignments yet. When a staff member asks a colleague a question or hands out work, it shows up here."
                : "Nothing open. Every question is answered and every task is in."}
            </p>
          </div>
        ) : (
          <ul className="assignment-tree" aria-label={filter === "open" ? "Open assignments" : "All assignments"}>
            {shown.map((node) => (
              <TreeNode key={node.assignment.id} node={node} agents={agents} now={now} onSelectAgent={onSelectAgent} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function TreeNode({ node, agents, now, onSelectAgent }: { node: AssignmentNode; agents: Agent[]; now: number; onSelectAgent(agentId: string): void }) {
  return (
    <li className="tree-node">
      <AssignmentCard assignment={node.assignment} agents={agents} now={now} withOwner level={3} onSelectAgent={onSelectAgent} />
      {node.children.length > 0 && (
        <ul className="tree-children" aria-label={`Handed out for “${node.assignment.title}”`}>
          {node.children.map((child) => (
            <TreeNode key={child.assignment.id} node={child} agents={agents} now={now} onSelectAgent={onSelectAgent} />
          ))}
        </ul>
      )}
    </li>
  );
}
