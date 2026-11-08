import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { argumentProblems } from "./catalog.ts";

const SEND = {
  type: "object",
  properties: {
    to: { type: "string" },
    subject: { type: "string" },
    limit: { type: "integer" },
    priority: { type: "string", enum: ["low", "high"] },
    labels: { type: ["array", "null"] },
    link_id: { type: "string" },
  },
  required: ["to", "subject", "link_id"],
  additionalProperties: false,
};

describe("Service arguments", () => {
  it("passes arguments that fit, and leaves link_id to AiHub", () => {
    assert.deepEqual(argumentProblems(SEND, { to: "anna@example.test", subject: "Hi", limit: 5, priority: "low", labels: null }), []);
    assert.deepEqual(argumentProblems(SEND, { to: "a", subject: "b", link_id: "someone-else" }), [], "AiHub replaces it");
  });

  it("names what is missing, unknown, of the wrong type, or outside its list", () => {
    assert.deepEqual(argumentProblems(SEND, { subject: 4, limit: 2.5, priority: "urgent", labels: "x", cc: "b@example.test" }), [
      "to is required",
      "subject must be a string, not a whole number",
      "limit must be a whole number, not a number",
      "priority must be one of \"low\", \"high\"",
      "labels must be a list or null, not a string",
      "cc isn't one of its arguments",
    ]);
  });

  it("checks only what a schema says plainly", () => {
    assert.deepEqual(argumentProblems(undefined, { anything: 1 }), []);
    assert.deepEqual(argumentProblems({ type: "object" }, { anything: 1 }), [], "extra arguments are allowed unless the schema says not");
    assert.deepEqual(argumentProblems({ properties: { when: { anyOf: [{ type: "string" }, { type: "number" }] } } }, { when: true }), [], "anyOf isn't checked");
  });
});
