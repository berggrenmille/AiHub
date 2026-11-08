import type { ModelChoice, ModelOption } from "@aihub/shared";
import type { ModelSetting } from "../runtime/types.ts";

// The model and reasoning level each staff member runs on (DESIGN.md › Staff and work model). The
// runtime's catalog says what there is. A staff member without a choice runs on the default model at
// that model's default reasoning, and AiHub names both on every turn, so what a run used is on record.

/** The catalog's default model, or its first. */
export function defaultModel(catalog: ModelOption[]): ModelOption | null {
  return catalog.find((option) => option.isDefault) ?? catalog[0] ?? null;
}

/**
 * What a staff member runs on: its choice where the catalog still offers it, otherwise the default
 * model, and the model's default reasoning in place of a level it lacks. Null for an empty catalog,
 * which leaves the choice to the runtime.
 */
export function resolveModel(choice: ModelChoice, catalog: ModelOption[]): ModelSetting | null {
  const option = catalog.find((model) => model.id === choice.model) ?? defaultModel(catalog);
  if (!option) return null;
  const effort = choice.effort && option.efforts.some((level) => level.effort === choice.effort) ? choice.effort : option.defaultEffort;
  return { model: option.id, effort };
}

/** Why a choice doesn't fit the catalog, or null when it does. A null model means the default. */
export function modelChoiceProblem(catalog: ModelOption[], choice: ModelChoice): string | null {
  if (!catalog.length) return "Codex offers no models right now.";
  const option = choice.model === null ? defaultModel(catalog) : catalog.find((model) => model.id === choice.model);
  if (!option) return `There is no model "${choice.model}". The models: ${catalog.map((model) => model.id).join(", ")}.`;
  if (choice.effort !== null && !option.efforts.some((level) => level.effort === choice.effort)) {
    return `${option.name} has no "${choice.effort}" reasoning. It has: ${option.efforts.map((level) => level.effort).join(", ")}.`;
  }
  return null;
}

/** Such as "GPT-6-Luna, medium reasoning". */
export function describeModel(setting: { model: string; effort: string | null }, catalog: ModelOption[]): string {
  const name = catalog.find((option) => option.id === setting.model)?.name ?? setting.model;
  return setting.effort ? `${name}, ${setting.effort} reasoning` : name;
}

/** The catalog as the Chief of Staff reads it when choosing for a new supervisor. */
export function catalogText(catalog: ModelOption[]): string {
  return catalog
    .map((option) => {
      const levels = option.efforts.map((level) => (level.effort === option.defaultEffort ? `${level.effort} (its default)` : level.effort));
      return `- ${option.id} (${option.name}${option.isDefault ? ", the office default" : ""}): ${option.description} Reasoning: ${levels.join(", ")}.`;
    })
    .join("\n");
}
