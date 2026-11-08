import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelOption } from "@aihub/shared";
import { describeModel, resolveChoice } from "./models.ts";

const level = (effort: string) => ({ effort, description: `${effort} reasoning` });
const MODELS: ModelOption[] = [
  { id: "sol", name: "Sol", description: "Workhorse.", efforts: ["low", "medium", "high"].map(level), defaultEffort: "low", isDefault: true },
  { id: "luna", name: "Luna", description: "Fast.", efforts: ["low", "medium"].map(level), defaultEffort: "medium", isDefault: false },
];

describe("Models", () => {
  it("resolves a staff member's choice the way the daemon does", () => {
    const of = (model: string | null, effort: string | null) => {
      const resolved = resolveChoice({ model, effort }, MODELS);
      return resolved && [resolved.option.id, resolved.effort];
    };
    assert.deepEqual(of(null, null), ["sol", "low"]);
    assert.deepEqual(of("luna", null), ["luna", "medium"]);
    assert.deepEqual(of("luna", "high"), ["luna", "medium"], "a level the model lacks");
    assert.deepEqual(of("retired", "high"), ["sol", "high"]);
    assert.equal(resolveChoice({ model: null, effort: null }, []), null);
  });

  it("names a model, or shows its id until the list is loaded", () => {
    assert.equal(describeModel("luna", "low", MODELS), "Luna, low reasoning");
    assert.equal(describeModel("luna", null, null), "luna");
  });
});
