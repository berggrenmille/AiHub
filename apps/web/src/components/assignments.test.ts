import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Assignment } from "@aihub/shared";
import { AssignmentList, AssignmentsDrawer } from "./Assignments.tsx";

const now = Date.parse("2026-11-07T17:00:00.000Z");

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    title: "",
    description: "",
    workingStyle: "",
    avatar: id,
    hiredAt: "2026-11-07T16:00:00.000Z",
    experience: 0,
    connectionIds: [],
    web: null,
    role: "supervisor",
    managerId: "vera",
    profile: "conversation",
    state: "idle",
    ...overrides,
  };
}

function assignment(id: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id,
    kind: "task",
    requesterId: "vera",
    requesterName: "Vera",
    ownerId: "nora",
    ownerName: "Nora",
    parentId: null,
    conversationId: null,
    title: `Task ${id}`,
    brief: "Do the thing.",
    status: "open",
    runBudget: 4,
    runsUsed: 1,
    result: null,
    review: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

const agents = [agent("vera", "Vera", { role: "chief_of_staff", managerId: null }), agent("nora", "Nora")];
const noop = () => {};

describe("assignment views", () => {
  const list = [
    assignment("t1", { status: "waiting", title: "Find focus time" }),
    assignment("w1", {
      requesterId: "nora",
      requesterName: "Nora",
      ownerId: "ture",
      ownerName: "Ture",
      parentId: "t1",
      status: "accepted",
      title: "Count meeting hours",
      result: "**31 h** <img src=x onerror=alert(1)>",
      review: "Accepted <script>alert(1)</script>",
      updatedAt: "2026-11-07T16:30:00.000Z",
    }),
    assignment("q1", { kind: "question", title: "Room next week?", status: "delivered", result: "Thursday.", updatedAt: "2026-11-07T16:40:00.000Z" }),
  ];

  it("draws the tree with each task's handed-out work nested under it", () => {
    const html = renderToStaticMarkup(createElement(AssignmentsDrawer, { assignments: list, agents, now, onSelectAgent: noop, onClose: noop }));
    // Open by default: the waiting task and its accepted worker task, not the settled question.
    assert.match(html, /<ul class="assignment-tree"[^>]*><li class="tree-node">.*Find focus time.*<ul class="tree-children"[^>]*><li class="tree-node">.*Count meeting hours/s);
    assert.ok(!html.includes("Room next week?"), "the settled question waits behind All");
    assert.ok(html.includes("Waiting on team"));
    assert.match(html, /aria-pressed="true"[^>]*>Open/);
  });

  it("links staff on the roster, marks those who left, and renders results safely", () => {
    const html = renderToStaticMarkup(createElement(AssignmentList, { assignments: list, agents, agentId: "nora", now, onSelectAgent: noop }));
    assert.match(html, /<button[^>]*class="person-name link-button"[^>]*>Vera<\/button>/);
    assert.match(html, /<strong class="person-name">Nora<\/strong>/, "the profile's own name isn't a link");
    assert.match(html, /Ture <span class="muted">\(left\)<\/span>/);
    assert.ok(html.includes("<strong>31 h</strong>"), "results are Markdown");
    assert.ok(!html.includes("<img") && !html.includes("<script"), html);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(html.includes("1/4 runs"));
    assert.ok(html.includes("The question and answer"));
  });
});
