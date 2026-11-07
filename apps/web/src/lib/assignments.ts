// Questions and tasks between staff (DESIGN.md › Recruitment and delegation, Asking colleagues):
// ordering, the delegation tree, and what each staff member shows on the floor because of them.
// Pure functions over records, so they can be tested on their own.

import type { Agent, Assignment, Run } from "@aihub/shared";
import { currentRun } from "./presence.ts";

/** The owner is still on it: working, or waiting for its team. */
export function isOpenAssignment(assignment: Assignment): boolean {
  return assignment.status === "open" || assignment.status === "waiting";
}

/**
 * The snapshot's order: open and waiting assignments first, newest first; then settled ones, the
 * most recently settled first.
 */
export function compareAssignments(a: Assignment, b: Assignment): number {
  const openA = isOpenAssignment(a);
  const openB = isOpenAssignment(b);
  if (openA !== openB) return openA ? -1 : 1;
  const byTime = openA ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt);
  return byTime || b.id.localeCompare(a.id);
}

export function sortAssignments(assignments: Assignment[]): Assignment[] {
  return [...assignments].sort(compareAssignments);
}

export function openAssignmentCount(assignments: Assignment[]): number {
  return assignments.filter(isOpenAssignment).length;
}

/** What a staff member owns or asked for, in the snapshot's order. */
export function assignmentsOf(agentId: string, assignments: Assignment[]): Assignment[] {
  return sortAssignments(assignments.filter((assignment) => assignment.ownerId === agentId || assignment.requesterId === agentId));
}

export interface AssignmentNode {
  assignment: Assignment;
  children: AssignmentNode[];
}

/**
 * Assignments as a forest: each one under the assignment it serves. One whose parent isn't in the
 * list, such as a settled task that has aged out, stands as a root. Siblings keep the snapshot's
 * order, and a parent loop can't hide anything.
 */
export function assignmentTree(assignments: Assignment[]): AssignmentNode[] {
  const sorted = sortAssignments(assignments);
  const ids = new Set(sorted.map((assignment) => assignment.id));
  const children = new Map<string, Assignment[]>();
  const roots: Assignment[] = [];
  for (const assignment of sorted) {
    if (assignment.parentId !== null && assignment.parentId !== assignment.id && ids.has(assignment.parentId)) {
      children.set(assignment.parentId, [...(children.get(assignment.parentId) ?? []), assignment]);
    } else {
      roots.push(assignment);
    }
  }
  const placed = new Set<string>();
  const build = (assignment: Assignment): AssignmentNode => {
    placed.add(assignment.id);
    const kids = (children.get(assignment.id) ?? []).filter((child) => !placed.has(child.id));
    return { assignment, children: kids.map(build) };
  };
  const forest = roots.map(build);
  // Assignments in a parent loop hang from nothing. Show them anyway.
  for (const assignment of sorted) if (!placed.has(assignment.id)) forest.push(build(assignment));
  return forest;
}

/** True when the node or anything under it is still open. */
export function hasOpenWork(node: AssignmentNode): boolean {
  return isOpenAssignment(node.assignment) || node.children.some(hasOpenWork);
}

/** A staff member's name, also for workers who have left: their assignments keep it. */
export function nameOf(agentId: string | null, agents: Agent[], assignments: Assignment[]): string | null {
  if (!agentId) return null;
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (agent) return agent.name;
  for (const assignment of assignments) {
    if (assignment.ownerId === agentId) return assignment.ownerName;
    if (assignment.requesterId === agentId) return assignment.requesterName;
  }
  return null;
}

/** A short line from longer text, cut at a word, for bubbles and badges. */
export function clip(text: string, limit = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, limit);
  const space = head.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? head.slice(0, space) : head).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** A supervisor's task that waits for its team, and how many of the team's tasks are in. */
export interface TeamWait {
  task: Assignment;
  total: number;
  settled: number;
}

export function teamWaitOf(agentId: string, assignments: Assignment[]): TeamWait | null {
  const task = sortAssignments(assignments).find((assignment) => assignment.ownerId === agentId && assignment.status === "waiting");
  if (!task) return null;
  const team = assignments.filter((assignment) => assignment.parentId === task.id);
  return { task, total: team.length, settled: team.filter((assignment) => !isOpenAssignment(assignment)).length };
}

/**
 * What a staff member is doing because of an assignment, for the floor: answering a colleague's
 * question, reviewing what came back, waiting on its team, or waiting for a colleague's answer.
 * A run in progress for anything else comes first; between runs, waiting shows.
 */
export type Errand =
  | { kind: "answering"; assignment: Assignment }
  | { kind: "reviewing"; assignment: Assignment | null }
  | { kind: "waiting_on_team"; wait: TeamWait }
  | { kind: "awaiting_answer"; assignment: Assignment };

export function errandOf(agentId: string, runs: Record<string, Run>, assignments: Assignment[]): Errand | null {
  const run = currentRun(agentId, runs);
  const assignment = run?.assignmentId ? (assignments.find((candidate) => candidate.id === run.assignmentId) ?? null) : null;
  if (run?.kind === "question" && assignment) return { kind: "answering", assignment };
  if (run?.kind === "follow_up") return { kind: "reviewing", assignment };
  if (run) return null;
  const wait = teamWaitOf(agentId, assignments);
  if (wait) return { kind: "waiting_on_team", wait };
  const asked = sortAssignments(openQuestions(assignments)).find((question) => question.requesterId === agentId);
  return asked ? { kind: "awaiting_answer", assignment: asked } : null;
}

/** Open questions between two staff members, for the still indicator when motion is off. */
export function openQuestions(assignments: Assignment[]): Assignment[] {
  return assignments.filter((assignment) => assignment.kind === "question" && assignment.status === "open");
}
