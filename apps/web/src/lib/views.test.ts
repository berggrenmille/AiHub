import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { View } from "@aihub/shared";
import { buttonEffect, dashboardsOf, formatNumber, imageSource, niceTicks, viewsByMessage, webUrl } from "./views.ts";

function view(overrides: Partial<View>): View {
  return {
    id: "view-1",
    kind: "reply",
    agentId: "chief-of-staff",
    runId: "run-1",
    messageId: 1,
    title: "A view",
    program: 'root = Stack([Text("Hi")])',
    outside: "ask",
    createdAt: "2026-11-07T16:00:00.000Z",
    updatedAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

describe("outside addresses in views", () => {
  it("opens only http and https pages", () => {
    assert.equal(webUrl("https://example.com/a")?.hostname, "example.com");
    assert.equal(webUrl("http://example.com")?.protocol, "http:");
    assert.equal(webUrl("javascript:alert(1)"), null);
    assert.equal(webUrl("file:///C:/secret.txt"), null);
    assert.equal(webUrl("/api/state"), null);
    assert.equal(webUrl(42), null);
  });

  it("loads an outside image by itself only where the view allows, and asks otherwise", () => {
    assert.deepEqual(imageSource("https://www.example.com/a.png", "load"), { kind: "load", src: "https://www.example.com/a.png" });
    assert.deepEqual(imageSource("https://www.example.com/a.png", "ask"), { kind: "ask", src: "https://www.example.com/a.png", site: "example.com" });
    assert.equal(imageSource("http://example.com/a.png", "load").kind, "blocked");
    assert.equal(imageSource("data:text/html;base64,PGI+", "load").kind, "blocked");
    assert.deepEqual(imageSource("data:image/png;base64,iVBORw0K", "ask"), { kind: "load", src: "data:image/png;base64,iVBORw0K" });
  });
});

describe("what a button does", () => {
  it("reads its action, not its label", () => {
    assert.deepEqual(buttonEffect("Details", { steps: [{ type: "open_url", url: "https://www.smhi.se/x" }] }), {
      says: "Opens smhi.se in a new tab",
      opens: "smhi.se",
    });
    assert.equal(buttonEffect("Show more", { steps: [{ type: "custom_action", name: "ResolveItem", params: { id: 7 } }] }).says, "Resolves item 7");
    assert.equal(buttonEffect("Ask", { steps: [{ type: "continue_conversation", message: "Why?" }] }).says, 'Puts "Why?" in the chat box');
    assert.equal(buttonEffect("Tell me more", undefined).says, 'Puts "Tell me more" in the chat box');
    assert.equal(buttonEffect("Week", { steps: [{ type: "set", target: "$range" }] }).says, "Changes what the view shows");
  });
});

describe("views by place", () => {
  it("groups views under their messages in the order handed in, leaving out dashboards and views not yet shown", () => {
    const views = {
      b: view({ id: "b", createdAt: "2026-11-07T16:01:00.000Z" }),
      a: view({ id: "a" }),
      c: view({ id: "c", messageId: 2 }),
      d: view({ id: "d", kind: "dashboard", messageId: null }),
      e: view({ id: "e", messageId: null }),
    };
    const grouped = viewsByMessage(views);
    assert.deepEqual(grouped.get(1)?.map((v) => v.id), ["a", "b"]);
    assert.deepEqual(grouped.get(2)?.map((v) => v.id), ["c"]);
    assert.equal(grouped.size, 2);
  });

  it("lists dashboards most recently changed first", () => {
    const views = {
      a: view({ id: "a", kind: "dashboard", messageId: null, updatedAt: "2026-11-07T10:00:00.000Z" }),
      b: view({ id: "b", kind: "dashboard", messageId: null, updatedAt: "2026-11-07T12:00:00.000Z" }),
      c: view({ id: "c" }),
    };
    assert.deepEqual(dashboardsOf(views).map((v) => v.id), ["b", "a"]);
  });
});

describe("chart axes", () => {
  it("picks round ticks from zero that cover the data", () => {
    assert.deepEqual(niceTicks([3, 47, 112]), [0, 50, 100, 150]);
    assert.deepEqual(niceTicks([0.2, 0.9]), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(niceTicks([-12, 30]), [-20, 0, 20, 40]);
    assert.deepEqual(niceTicks([]), [0, 1]);
  });

  it("writes numbers in full under 10,000 and compact above", () => {
    assert.equal(formatNumber(1284), "1,284");
    assert.equal(formatNumber(12_900), "12.9K");
    assert.equal(formatNumber(0.25), "0.25");
  });
});
