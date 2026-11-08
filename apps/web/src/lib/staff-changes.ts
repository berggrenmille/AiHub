import type { ModelOption, StaffChange } from "@aihub/shared";
import { describeModel } from "./models.ts";

// Staff changes the Chief of Staff proposes (DESIGN.md › Staff review): what each card says it does.

/** What a change does, such as "Replace Nora with Ada". */
export function staffChangeTitle(change: StaffChange, models: ModelOption[] | null): string {
  const { agentName: name, responsibilityTitle: title } = change;
  switch (change.change.kind) {
    case "instructions":
      return `New instructions for ${name}`;
    case "model":
      return `Run ${name} on ${describeModel(change.change.model.id, change.change.model.effort, models)}`;
    case "end":
      return `End ${title}`;
    case "replace":
      return `Replace ${name} with ${change.change.profile.name}`;
  }
}

/** What the supervisor runs on before the change, such as "the office default". */
export function modelBefore(change: StaffChange, models: ModelOption[] | null): string | null {
  if (change.change.kind !== "model") return null;
  const { model, effort } = change.change.before;
  if (model === null) return effort ? `the office default, ${effort} reasoning` : "the office default";
  return describeModel(model, effort, models);
}

/** Changes still waiting for the operator. */
export function pendingStaffChanges(changes: StaffChange[]): StaffChange[] {
  return changes.filter((change) => change.status === "pending");
}
