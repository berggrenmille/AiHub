import type { PolicyVersion } from "@aihub/shared";

// The office policy (DESIGN.md › Memory and notes): the current version, the proposal waiting for the
// operator, and what a proposal changes, line by line.

export const POLICY_LIMIT = 4000;

/** The policy staff work under: the newest approved version. */
export function currentPolicy(policies: PolicyVersion[]): PolicyVersion | null {
  const approved = policies.filter((policy) => policy.status === "approved");
  approved.sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || b.id - a.id);
  return approved[0] ?? null;
}

/** The proposal waiting for the operator, if any. */
export function pendingPolicy(policies: PolicyVersion[]): PolicyVersion | null {
  return policies.filter((policy) => policy.status === "pending").sort((a, b) => b.id - a.id)[0] ?? null;
}

/** The text a proposal changes: the version it was based on, empty for the first, or null when that version isn't loaded. */
export function baseOf(proposal: PolicyVersion, policies: PolicyVersion[]): string | null {
  if (proposal.basedOn === null) return "";
  return policies.find((policy) => policy.id === proposal.basedOn)?.body ?? null;
}

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Line by line, along the longest common subsequence. A policy is short, so the full table is cheap. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      lines.push({ kind: "removed", text: a[i++]! });
    } else {
      lines.push({ kind: "added", text: b[j++]! });
    }
  }
  while (i < a.length) lines.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) lines.push({ kind: "added", text: b[j++]! });
  return lines;
}
