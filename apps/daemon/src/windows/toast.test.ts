import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { officeUrl, toastTag, toastXml } from "./toast.ts";
import { escapeXml } from "./xml.ts";

const ORIGIN = "http://127.0.0.1:7420";

describe("toasts", () => {
  it("escapes every XML special character and drops what XML can't hold", () => {
    assert.equal(escapeXml(`<b>"Tom" & 'Jerry'</b>`), "&lt;b&gt;&quot;Tom&quot; &amp; &apos;Jerry&apos;&lt;/b&gt;");
    assert.equal(escapeXml("bell\u0007 tab\t line\nend￿"), "bell tab\t line\nend");
    assert.equal(escapeXml("broken \uD800 pair, whole 😀"), "broken  pair, whole 😀");
  });

  it("shows a title and body that open the office when clicked", () => {
    const xml = toastXml({ title: "Briefing <ready>", body: `3 new & 1 "urgent"`, path: "/inbox?item=a&b=1" }, ORIGIN);
    assert.equal(
      xml,
      '<toast activationType="protocol" launch="http://127.0.0.1:7420/inbox?item=a&amp;b=1">' +
        '<visual><binding template="ToastGeneric">' +
        "<text>Briefing &lt;ready&gt;</text><text>3 new &amp; 1 &quot;urgent&quot;</text>" +
        "</binding></visual></toast>",
    );
  });

  it("leaves out an empty body and shortens long text", () => {
    assert.doesNotMatch(toastXml({ title: "Only a title", body: "  " }, ORIGIN), /<text>\s*<\/text>/);
    const long = toastXml({ title: "t", body: "å".repeat(600) }, ORIGIN);
    const body = /<text>(å+…)<\/text>/.exec(long)?.[1];
    assert.equal([...body!].length, 500);
  });

  it("only ever opens the office", () => {
    assert.equal(officeUrl(ORIGIN), `${ORIGIN}/`);
    assert.equal(officeUrl(ORIGIN, "/chat/cos"), `${ORIGIN}/chat/cos`);
    for (const path of ["//evil.example/x", "http://evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
      assert.equal(officeUrl(ORIGIN, path), `${ORIGIN}/`, path);
    }
  });

  it("keeps tags short enough for Windows, and distinct", () => {
    assert.equal(toastTag("briefing-2026-11-09"), "briefing-2026-11-09");
    const a = toastTag(`briefing-${"x".repeat(80)}-a`);
    const b = toastTag(`briefing-${"x".repeat(80)}-b`);
    assert.equal(a.length, 64);
    assert.notEqual(a, b);
  });
});
