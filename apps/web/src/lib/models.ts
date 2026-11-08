import type { ModelChoice, ModelOption } from "@aihub/shared";

// What staff run on (DESIGN.md › Staff and work model), resolved the way the daemon resolves it: a
// staff member's choice where Codex still offers it, otherwise the office default, and the model's
// default reasoning in place of a level it lacks.

/** The office default: the model Codex marks as its default, or its first. */
export function defaultModel(models: ModelOption[]): ModelOption | null {
  return models.find((option) => option.isDefault) ?? models[0] ?? null;
}

export interface ResolvedModel {
  option: ModelOption;
  effort: string;
}

export function resolveChoice(choice: ModelChoice, models: ModelOption[]): ResolvedModel | null {
  const option = models.find((model) => model.id === choice.model) ?? defaultModel(models);
  if (!option) return null;
  const effort = choice.effort && option.efforts.some((level) => level.effort === choice.effort) ? choice.effort : option.defaultEffort;
  return { option, effort };
}

/** A model's name, or its id while the list isn't loaded or no longer has it. */
export function modelName(id: string, models: ModelOption[] | null): string {
  return models?.find((option) => option.id === id)?.name ?? id;
}

/** Such as "GPT-6-Luna, medium reasoning". */
export function describeModel(id: string, effort: string | null, models: ModelOption[] | null): string {
  return effort ? `${modelName(id, models)}, ${effort} reasoning` : modelName(id, models);
}
