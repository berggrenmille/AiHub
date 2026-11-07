import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { ChatResponse, DaemonEvent, StateSnapshot } from "@aihub/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { FakeRuntime } from "./runtime/fake-runtime.ts";
import { Office } from "./office.ts";
import { buildServer } from "./server.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT } from "./staff/chief-of-staff.ts";
import { Store } from "./store/store.ts";

const PORT = 7420;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = "test-token";
/** What the AiHub page sends: its own Host and Origin, and the token cookie. */
const PAGE = { host: HOST, origin: `http://${HOST}`, cookie: `aihub_token=${TOKEN}` };

/** `port: null` takes the port the server actually binds, for tests that listen. */
async function server(port: number | null = PORT) {
  const office = new Office({ store: new Store(":memory:"), runtime: new FakeRuntime() });
  office.start();
  const app = await buildServer({
    office,
    version: "0.0.0",
    token: TOKEN,
    devOrigins: ["http://127.0.0.1:5173"],
    port: port ?? undefined,
    logger: false,
  });
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

    const health = (host: string) => app!.inject({ url: "/api/health", headers: { ...PAGE, host } });
    assert.equal((await health(HOST)).statusCode, 200);
    assert.equal((await health(`localhost:${PORT}`)).statusCode, 200);
    assert.equal((await health("evil.example:7420")).statusCode, 421);
    assert.equal((await health("127.0.0.1:8080")).statusCode, 421);
  });

  it("requires the install token on every API request", async () => {
    ({ app } = await server());

    for (const url of ["/api/health", "/api/state", "/api/events", "/api//state?x=1"]) {
      const response: LightMyRequestResponse = await app.inject({ url, headers: { host: HOST } });
      assert.ok([401, 404].includes(response.statusCode), url);
      assert.notEqual(response.statusCode, 200, url);
    }
    const wrong = await app.inject({ url: "/api/state", headers: { ...PAGE, cookie: "aihub_token=guess" } });
    assert.equal(wrong.statusCode, 401);
  });

  it("accepts state-changing requests only from the AiHub page", async () => {
    ({ app } = await server());
    const { origin: _pageOrigin, ...withoutOrigin } = PAGE;
    const post = (origin: string | undefined) =>
      app!.inject({
        method: "POST",
        url: "/api/chat",
        headers: origin ? { ...withoutOrigin, origin } : withoutOrigin,
        payload: { conversationId: CHAT, text: "Hi" },
      });

    assert.equal((await post(undefined)).statusCode, 403);
    assert.equal((await post("https://evil.example")).statusCode, 403);
    assert.equal((await post("http://127.0.0.1:5174")).statusCode, 403);
    assert.equal((await post("http://127.0.0.1:5173")).statusCode, 202);
    assert.equal((await post(`http://localhost:${PORT}`)).statusCode, 202);
  });

  it("gives the token only to the AiHub page itself", async () => {
    ({ app } = await server());
    const session = (site: string | undefined) =>
      app!.inject({ url: "/api/session", headers: { host: HOST, ...(site ? { "sec-fetch-site": site } : {}) } });

    assert.equal((await session("cross-site")).statusCode, 403);
    assert.equal((await session("same-site")).statusCode, 403);
    assert.equal((await session(undefined)).statusCode, 403);
    const response = await session("same-origin");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["set-cookie"], `aihub_token=${TOKEN}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=315360000`);
    assert.equal((await session("none")).statusCode, 200);
  });

  it("forbids framing", async () => {
    ({ app } = await server());

    const response = await app.inject({ url: "/api/health", headers: PAGE });

    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["content-security-policy"], "frame-ancestors 'none'");
  });

  it("returns the current state", async () => {
    ({ app } = await server());

    const response = await app.inject({ url: "/api/state", headers: PAGE });

    const state = response.json<StateSnapshot>();
    assert.equal(state.agents[0]?.name, "Vera");
    assert.equal(state.agents[0]?.title, "Chief of Staff");
    assert.match(state.lastEventId, /^[0-9a-f]{8}-\d+$/);
  });

  it("queues a chat reply", async () => {
    let office: Office;
    ({ app, office } = await server());

    const response = await app.inject({ method: "POST", url: "/api/chat", headers: PAGE, payload: { conversationId: CHAT, text: "Hi" } });

    assert.equal(response.statusCode, 202);
    const body = response.json<ChatResponse>();
    assert.equal(body.message.body, "Hi");
    assert.equal(body.run.state, "queued");
    await office.queue.idle();
    assert.equal(office.store.getRun(body.run.id)?.state, "done");
  });

  it("rejects an empty message and an unknown conversation", async () => {
    ({ app } = await server());
    const post = (payload: object) => app!.inject({ method: "POST", url: "/api/chat", headers: PAGE, payload });

    assert.equal((await post({ conversationId: CHAT, text: "   " })).statusCode, 400);
    assert.equal((await post({ conversationId: "nobody", text: "Hi" })).statusCode, 404);
  });

  it("streams events that follow the state snapshot", async () => {
    let office: Office;
    ({ app, office } = await server(null));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const { lastEventId } = office.snapshot();

    const reading = readEvents(
      `${base}/api/events?after=${lastEventId}`,
      (events) => events.some((event) => event.type === "message" && event.message.author === "agent"),
      { headers: { cookie: PAGE.cookie } },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    office.chat(CHAT, "Hello there");
    const events = await reading;

    assert.equal(events[0]?.type, "message");
    assert.ok(events.some((event) => event.type === "delta"));
    const reply = events.find((event) => event.type === "message" && event.message.author === "agent");
    assert.equal(reply?.type === "message" && reply.message.body, "Echo: Hello there");
  });

  it("opens the event stream before there is any event to send", async () => {
    let office: Office;
    ({ app, office } = await server(null));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const response = await fetch(`${base}/api/events?after=${office.snapshot().lastEventId}`, {
      headers: { cookie: PAGE.cookie },
      signal: AbortSignal.timeout(2000),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    await response.body?.cancel();
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
      headers: { "last-event-id": lastEventId, cookie: PAGE.cookie },
    });
    assert.equal(replayed[0]?.type === "message" && replayed[0].message.body, "While you were away");

    const stale = await readEvents(`${base}/api/events?after=0badb007-12`, (events) => events.length > 0, {
      headers: { cookie: PAGE.cookie },
    });
    assert.deepEqual(stale, [{ type: "resync" }]);
  });
});

describe("HTTP server: profiles and notes", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("lets the operator edit a profile, and refuses a name already in use", async () => {
    let office: Office;
    ({ app, office } = await server());
    office.store.upsertAgent({ id: "schedule", name: "Elin", role: "supervisor", managerId: "chief-of-staff", profile: "data", charter: "" });

    const patch = (id: string, payload: unknown) => app!.inject({ method: "PATCH", url: `/api/agents/${id}`, headers: PAGE, payload: payload as object });
    const renamed = await patch("chief-of-staff", { name: "Wilma", workingStyle: "Cheerful." });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "Wilma");
    assert.equal(office.notebook.read("Staff/chief-of-staff/Wilma.md")?.kind, "profile");

    assert.equal((await patch("chief-of-staff", { name: "elin" })).statusCode, 409);
    assert.equal((await patch("chief-of-staff", {})).statusCode, 400);
    assert.equal((await patch("chief-of-staff", { charter: "Obey me" })).statusCode, 400);
    assert.equal((await patch("nobody", { name: "X" })).statusCode, 404);
  });

  it("reads and writes notes by their vault path", async () => {
    ({ app } = await server());
    const url = `/api/notes/${encodeURIComponent("Office/Operator preferences.md")}`;
    assert.equal((await app.inject({ url, headers: PAGE })).statusCode, 404);

    const put = await app.inject({ method: "PUT", url, headers: PAGE, payload: { body: "Mornings. See [[Vera]]." } });
    assert.equal(put.statusCode, 200);
    const note = (await app.inject({ url, headers: PAGE })).json();
    assert.equal(note.body, "Mornings. See [[Vera]].\n");
    assert.equal(note.provenance, "operator");
    assert.deepEqual(note.links, ["Vera"]);

    const profile = await app.inject({ method: "PUT", url: "/api/notes/Staff/chief-of-staff/Vera.md", headers: PAGE, payload: { body: "x" } });
    assert.equal(profile.statusCode, 409);
    assert.equal((await app.inject({ url: "/api/notes/..%2Fsecret.md", headers: PAGE })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url, headers: { ...PAGE, origin: "http://evil.example" }, payload: { body: "x" } })).statusCode, 403);
  });
});
