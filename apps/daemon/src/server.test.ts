import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { ChatResponse, DaemonEvent, StateSnapshot } from "@aihub/shared";
import type { FastifyInstance } from "fastify";
import { FakeRuntime } from "../test/fake-runtime.ts";
import { Office } from "./office.ts";
import { buildServer } from "./server.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT } from "./staff/chief-of-staff.ts";
import { Store } from "./store/store.ts";

const PORT = 7420;
const HOST = `127.0.0.1:${PORT}`;

/** `port: null` takes the port the server actually binds, for tests that listen. */
async function server(port: number | null = PORT) {
  const office = new Office({ store: new Store(":memory:"), runtime: new FakeRuntime() });
  office.start();
  const app = await buildServer({ office, version: "0.0.0", port: port ?? undefined, logger: false });
  return { office, app };
}

/** Reads server-sent events from a live server until `until` returns true. */
async function readEvents(url: string, until: (events: DaemonEvent[]) => boolean, init?: RequestInit) {
  const response = await fetch(url, init);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: DaemonEvent[] = [];
  let buffer = "";
  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop()!;
    for (const block of blocks) {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)) as DaemonEvent);
    }
  }
  await reader.cancel();
  return events;
}

describe("HTTP server", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("answers only requests addressed to the loopback daemon", async () => {
    ({ app } = await server());

    assert.equal((await app.inject({ url: "/api/health", headers: { host: HOST } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/health", headers: { host: `localhost:${PORT}` } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/health", headers: { host: "evil.example:7420" } })).statusCode, 421);
    assert.equal((await app.inject({ url: "/api/health", headers: { host: "127.0.0.1:8080" } })).statusCode, 421);
  });

  it("returns the current state", async () => {
    ({ app } = await server());

    const response = await app.inject({ url: "/api/state", headers: { host: HOST } });

    const state = response.json<StateSnapshot>();
    assert.equal(state.agents[0]?.name, "Chief of Staff");
    assert.match(state.lastEventId, /^[0-9a-f]{8}-\d+$/);
  });

  it("queues a chat reply", async () => {
    let office: Office;
    ({ app, office } = await server());

    const response = await app.inject({ method: "POST", url: "/api/chat", headers: { host: HOST }, payload: { conversationId: CHAT, text: "Hi" } });

    assert.equal(response.statusCode, 202);
    const body = response.json<ChatResponse>();
    assert.equal(body.message.body, "Hi");
    assert.equal(body.run.state, "queued");
    await office.queue.idle();
    assert.equal(office.store.getRun(body.run.id)?.state, "done");
  });

  it("rejects an empty message and an unknown conversation", async () => {
    ({ app } = await server());
    const post = (payload: object) => app!.inject({ method: "POST", url: "/api/chat", headers: { host: HOST }, payload });

    assert.equal((await post({ conversationId: CHAT, text: "   " })).statusCode, 400);
    assert.equal((await post({ conversationId: "nobody", text: "Hi" })).statusCode, 404);
  });

  it("streams events that follow the state snapshot", async () => {
    let office: Office;
    ({ app, office } = await server(null));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const { lastEventId } = office.snapshot();

    const reading = readEvents(`${base}/api/events?after=${lastEventId}`, (events) =>
      events.some((event) => event.type === "message" && event.message.author === "agent"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    office.chat(CHAT, "Hello there");
    const events = await reading;

    assert.equal(events[0]?.type, "message");
    assert.ok(events.some((event) => event.type === "delta"));
    const reply = events.find((event) => event.type === "message" && event.message.author === "agent");
    assert.equal(reply?.type === "message" && reply.message.body, "Echo: Hello there");
  });

  it("replays missed events after a reconnect and asks for a reload after a restart", async () => {
    let office: Office;
    ({ app, office } = await server(null));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const { lastEventId } = office.snapshot();
    office.chat(CHAT, "While you were away");
    await office.queue.idle();

    const replayed = await readEvents(`${base}/api/events`, (events) => events.some((event) => event.type === "message"), {
      headers: { "last-event-id": lastEventId },
    });
    assert.equal(replayed[0]?.type === "message" && replayed[0].message.body, "While you were away");

    const stale = await readEvents(`${base}/api/events?after=0badb007-12`, (events) => events.length > 0);
    assert.deepEqual(stale, [{ type: "resync" }]);
  });
});
