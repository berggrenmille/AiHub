import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAKE_MODELS } from "../runtime/fake-runtime.ts";
import { describeModel, modelChoiceProblem, resolveModel } from "./models.ts";

describe("Models", () => {
  it("resolves a choice to what the catalog offers", () => {
    assert.deepEqual(resolveModel({ model: null, effort: null }, FAKE_MODELS), { model: "fake-standard", effort: "low" });
    assert.deepEqual(resolveModel({ model: "fake-light", effort: null }, FAKE_MODELS), { model: "fake-light", effort: "medium" });
    assert.deepEqual(resolveModel({ model: "fake-light", effort: "high" }, FAKE_MODELS), { model: "fake-light", effort: "medium" }, "a level the model lacks");
    assert.deepEqual(resolveModel({ model: "gone", effort: "high" }, FAKE_MODELS), { model: "fake-standard", effort: "high" });
    assert.equal(resolveModel({ model: "fake-light", effort: "low" }, []), null);
  });

  it("explains a choice that doesn't fit, and names one for people", () => {
    assert.equal(modelChoiceProblem(FAKE_MODELS, { model: "fake-light", effort: "low" }), null);
    assert.equal(modelChoiceProblem(FAKE_MODELS, { model: null, effort: "high" }), null);
    assert.equal(modelChoiceProblem(FAKE_MODELS, { model: null, effort: "max" }), 'Fake Standard has no "max" reasoning. It has: low, medium, high.');
    assert.equal(modelChoiceProblem([], { model: null, effort: null }), "Codex offers no models right now.");
    assert.equal(describeModel({ model: "fake-light", effort: "low" }, FAKE_MODELS), "Fake Light, low reasoning");
    assert.equal(describeModel({ model: "gpt-x", effort: null }, FAKE_MODELS), "gpt-x");
  });
});
