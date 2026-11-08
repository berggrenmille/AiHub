import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { argumentProblems, groupedGrants, riskGroup, unsafeKey } from "./catalog.ts";
import type { ServiceTool } from "../store/store.ts";

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

describe("Unsafe ticks", () => {
  const code = { id: "svc-code", name: "Code host", kind: "remote_mcp" as const };
  const tool = (name: string, annotations: ServiceTool["annotations"] = null): ServiceTool => ({ name, title: null, description: "", annotations, inputSchema: {}, outputSchema: null });

  it("groups a service's unsafe operations by what they can do, and never puts a destructive one with the rest", () => {
    const tools = [
      tool("list_issues", { readOnlyHint: true, openWorldHint: false }),
      tool("search_web", { readOnlyHint: true }),
      tool("add_reaction", { readOnlyHint: false, destructiveHint: false }),
      tool("create_issue", { readOnlyHint: false, destructiveHint: false }),
      tool("delete_file", { readOnlyHint: false, destructiveHint: true }),
      tool("push_files", { readOnlyHint: false }),
      tool("mystery"),
    ];
    assert.deepEqual(tools.map(riskGroup), ["reach", "reach", "change", "change", "destroy", "destroy", "destroy"]);

    const grants = groupedGrants(tools.map((one) => ({ service: code, tool: one })), "Ines");
    assert.deepEqual(
      grants.map((grant) => [grant.key, grant.what, grant.required]),
      [
        [unsafeKey.operations(code.id, "reach"), "Reach others through Code host: search_web", false],
        [unsafeKey.operations(code.id, "change"), "Add or change things on Code host: add_reaction and create_issue", false],
        [unsafeKey.operations(code.id, "destroy"), "Delete or overwrite things on Code host: delete_file, push_files, and mystery", false],
      ],
      "list_issues only reads the service, so it needs no tick",
    );
    assert.match(grants[2]!.risk, /^These can delete or overwrite things outside the office\. Code host doesn't say what mystery does, so it counts as this\./);
  });

  it("keeps each service's ticks apart, and words a program on this PC as one", () => {
    const mail = { id: "svc-mail", name: "Work mail", kind: "remote_mcp" as const };
    const local = { id: "svc-files", name: "Files", kind: "local_mcp" as const };
    const grants = groupedGrants(
      [
        { service: code, tool: tool("add_reaction", { readOnlyHint: false, destructiveHint: false }) },
        { service: mail, tool: tool("send_message", { readOnlyHint: false, destructiveHint: false }) },
        { service: local, tool: tool("read_file", { readOnlyHint: true, openWorldHint: false }) },
      ],
      "Ines",
    );
    assert.deepEqual(grants.map((grant) => grant.key), [unsafeKey.operations(code.id, "change"), unsafeKey.operations(mail.id, "change"), unsafeKey.operations(local.id, "reach")]);
    assert.match(grants[0]!.risk, /^add_reaction changes things outside the office, though Code host says not by deleting or overwriting\./);
    assert.match(grants[2]!.risk, /^Files is a program on this PC that runs outside AiHub's sandbox/);
  });
});
