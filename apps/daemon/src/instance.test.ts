import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { askHealth } from "./instance.ts";
import { Office } from "./office.ts";
import { FakeRuntime } from "./runtime/fake-runtime.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store/store.ts";

describe("who has the port", () => {
  it("tells this office's daemon from another AiHub", async () => {
    const office = new Office({ store: new Store(":memory:"), runtime: new FakeRuntime() });
    const app = await buildServer({ office, version: "1.2.3", token: "ours", logger: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
      const ours = await askHealth(port, "ours");
      assert.equal(ours.kind, "aihub");
      assert.equal(ours.kind === "aihub" && ours.version, "1.2.3");
      assert.deepEqual(await askHealth(port, "theirs"), { kind: "other-aihub" });
      assert.deepEqual(await askHealth(port, null), { kind: "other-aihub" });
    } finally {
      await app.close();
    }
    assert.deepEqual(await askHealth(port, "ours"), { kind: "none" });
  });

  it("knows a program that isn't AiHub", async () => {
    const server = createServer((_request, response) => response.end("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      assert.deepEqual(await askHealth(port, "ours"), { kind: "other", detail: "HTTP 200" });
    } finally {
      server.close();
    }
  });
});
