import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../components/Markdown.tsx";
import { inlineText, parseInline, parseMarkdown, parseWikilink, safeHref } from "./markdown.ts";

const render = (source: string, resolveLink?: (target: string) => { exists: boolean }) =>
  renderToStaticMarkup(createElement(Markdown, { source, resolveLink, onOpenLink: () => {} }));

describe("markdown parsing", () => {
  it("parses headings, lists with tasks, quotes, code and rules", () => {
    const blocks = parseMarkdown("# Title\n\n- [x] done\n- [ ] todo\n  more\n\n1. one\n2. two\n\n> quoted\n\n```js\nlet a = 1;\n```\n\n---");
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["heading", "list", "list", "quote", "code", "rule"],
    );
    const tasks = blocks[1];
    assert.ok(tasks?.type === "list");
    assert.deepEqual(tasks.items.map((item) => item.checked), [true, false]);
    assert.equal(inlineText(tasks.items[1]!.children), "todo more");
    const ordered = blocks[2];
    assert.ok(ordered?.type === "list" && ordered.ordered && ordered.start === 1);
    assert.deepEqual(blocks[4], { type: "code", lang: "js", text: "let a = 1;" });
  });

  it("parses emphasis, code, strike and links, leaving snake_case alone", () => {
    assert.deepEqual(parseInline("**bold** and *em* and `x < y` and ~~old~~"), [
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "em" }] },
      { type: "text", text: " and " },
      { type: "code", text: "x < y" },
      { type: "text", text: " and " },
      { type: "strike", children: [{ type: "text", text: "old" }] },
    ]);
    assert.deepEqual(parseInline("snake_case_name"), [{ type: "text", text: "snake_case_name" }]);
    assert.deepEqual(parseInline("[site](https://example.com)"), [{ type: "link", href: "https://example.com", children: [{ type: "text", text: "site" }] }]);
    assert.deepEqual(parseInline("see https://example.com/a."), [
      { type: "text", text: "see " },
      { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "https://example.com/a" }] },
      { type: "text", text: "." },
    ]);
  });

  it("parses wikilinks with headings and aliases", () => {
    assert.deepEqual(parseWikilink("Anna Lindqvist#Notes|Anna"), { target: "Anna Lindqvist", heading: "Notes", alias: "Anna" });
    assert.deepEqual(parseInline("ask [[Anna Lindqvist#Notes]]"), [
      { type: "text", text: "ask " },
      { type: "wikilink", target: "Anna Lindqvist", heading: "Notes", label: "Anna Lindqvist › Notes" },
    ]);
    assert.deepEqual(parseInline("[[Q4 planning|the plan]]"), [{ type: "wikilink", target: "Q4 planning", heading: null, label: "the plan" }]);
  });

  it("only lets http, https and mailto links through", () => {
    assert.equal(safeHref("https://example.com"), "https://example.com");
    assert.equal(safeHref("mailto:anna@example.com"), "mailto:anna@example.com");
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref("JaVaScRiPt:alert(1)"), null);
    assert.equal(safeHref("java\tscript:alert(1)"), null);
    assert.equal(safeHref("data:text/html,<b>x</b>"), null);
    assert.equal(safeHref("/relative"), null);
    // An unsafe link keeps its label and shows its target as text.
    assert.deepEqual(parseInline("[click](javascript:alert(1))"), [
      { type: "text", text: "click" },
      { type: "text", text: " (javascript:alert(1))" },
    ]);
  });

  it("keeps raw HTML as text", () => {
    assert.deepEqual(parseInline('<script>alert("x")</script>'), [{ type: "text", text: '<script>alert("x")</script>' }]);
  });
});

describe("markdown rendering", () => {
  it("escapes HTML from untrusted text", () => {
    const html = render('Hi <script>alert("x")</script> <img src=x onerror=alert(1)>\n\n**<b>bold</b>**');
    assert.ok(!html.includes("<script"), html);
    assert.ok(!html.includes("<img"), html);
    assert.ok(!html.includes("<b>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), html);
  });

  it("never renders an unsafe link as a link", () => {
    const html = render("[click](javascript:alert(1)) and [ok](https://example.com)");
    assert.ok(!html.includes('href="javascript'), html);
    assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/);
  });

  it("renders wikilinks as buttons when the note exists, and as text otherwise", () => {
    const html = render("[[Anna]] and [[Nobody]]", (target) => ({ exists: target === "Anna" }));
    assert.match(html, /<button[^>]*>Anna<\/button>/);
    assert.ok(!/<button[^>]*>Nobody<\/button>/.test(html), html);
    assert.ok(html.includes("Nobody"));
  });
});
