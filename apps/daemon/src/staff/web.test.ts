import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidRequestError } from "../errors.ts";
import { describeWeb, MAX_SITES, normalizeSites, webAccessOf } from "./web.ts";

describe("Web search grants", () => {
  it("keeps only the site of each address, once", () => {
    assert.deepEqual(normalizeSites([" https://www.BBC.com/news?x=1 ", "reuters.com:443", "", "bbc.com", "www.bbc.com"]), ["www.bbc.com", "reuters.com", "bbc.com"]);
  });

  it("refuses what isn't a site, and too many sites", () => {
    assert.throws(() => normalizeSites(["localhost"]), InvalidRequestError);
    assert.throws(() => normalizeSites(["not a site"]), /isn't a site/);
    const many = Array.from({ length: MAX_SITES + 1 }, (_, n) => `site${n}.com`);
    assert.throws(() => normalizeSites(many), /at most 20 sites/);
  });

  it("searches in cached mode only, and says where", () => {
    assert.deepEqual(webAccessOf({ sites: ["bbc.com"] }), { mode: "cached", sites: ["bbc.com"] });
    assert.equal(webAccessOf(null), null);
    assert.equal(describeWeb({ sites: [] }), "web search");
    assert.equal(describeWeb({ sites: ["bbc.com", "ap.org", "reuters.com"] }), "web search on bbc.com, ap.org and reuters.com");
  });
});
