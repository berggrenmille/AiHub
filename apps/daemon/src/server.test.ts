import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { ChatResponse, DaemonEvent, Meeting, OpenChatResponse, StateSnapshot } from "@aihub/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { FakeRuntime } from "./runtime/fake-runtime.ts";
import { Office } from "./office.ts";
import { Scheduler } from "./scheduler.ts";
import { buildServer } from "./server.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID as CHAT, CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";
import { Store } from "./store/store.ts";

const PORT = 7420;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = "test-token";
/** What the AiHub page sends: its own Host and Origin, and the token cookie. */
const PAGE = { host: HOST, origin: `http://${HOST}`, cookie: `aihub_token=${TOKEN}` };

/** `port: null` takes the port the server actually binds, for tests that listen. */
async function server(port: number | null = PORT, onQuit?: () => void) {
  const office = new Office({ store: new Store(":memory:"), runtime: new FakeRuntime() });
  office.start();
  const app = await buildServer({
    office,
    version: "0.0.0",
    token: TOKEN,
    devOrigins: ["http://127.0.0.1:5173"],
    port: port ?? undefined,
    logger: false,
    onQuit,
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

  it("lets the background daemon be asked to quit, with the token and from its own origin", async () => {
    ({ app } = await server());
    assert.equal((await app.inject({ method: "POST", url: "/api/quit", headers: PAGE })).statusCode, 404, "a daemon in a terminal has no quit");
    await app.close();

    let quits = 0;
    ({ app } = await server(PORT, () => quits++));
    const quit = (headers: Record<string, string>) => app!.inject({ method: "POST", url: "/api/quit", headers });
    assert.equal((await quit({ host: HOST, origin: `http://${HOST}` })).statusCode, 401);
    assert.equal((await quit({ ...PAGE, origin: "http://evil.example" })).statusCode, 403);
    const asked = await quit(PAGE);
    assert.equal(asked.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(quits, 1);
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
    assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(response.headers["content-security-policy"]), /script-src 'self'/);
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

  it("starts and renames a topic", async () => {
    ({ app } = await server());
    const started = await app.inject({ method: "POST", url: `/api/agents/${CHIEF_OF_STAFF_ID}/topics`, headers: PAGE, payload: {} });
    assert.equal(started.statusCode, 201);
    const { conversation } = started.json<OpenChatResponse>();
    assert.deepEqual([conversation.title, conversation.kind], ["New topic", "topic"]);
    const rename = (id: string, title: string) => app!.inject({ method: "PATCH", url: `/api/conversations/${id}`, headers: PAGE, payload: { title } });
    assert.equal((await rename(conversation.id, "Travel")).json<OpenChatResponse>().conversation.title, "Travel");
    assert.equal((await rename(CHAT, "Travel")).statusCode, 409);
    assert.equal((await rename("nobody", "Travel")).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/nobody/topics", headers: PAGE, payload: {} })).statusCode, 404);
  });

  it("calls a meeting, takes what the operator says in it, and ends it", async () => {
    let office: Office;
    ({ app, office } = await server());
    const post = (url: string, payload?: Record<string, unknown>) => app!.inject({ method: "POST", url, headers: PAGE, ...(payload && { payload }) });
    assert.equal((await post("/api/meetings", { agenda: "Anyone?" })).statusCode, 409, "no supervisors yet");
    office.store.upsertAgent({ id: "elin", name: "Elin", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "Keeps a calendar." });
    assert.equal((await post("/api/meetings", { agenda: "" })).statusCode, 400);

    const called = await post("/api/meetings", { agenda: "Plan the week", participantIds: ["elin"] });
    assert.equal(called.statusCode, 201);
    const meeting = called.json<Meeting>();
    assert.deepEqual([meeting.title, meeting.calledBy, meeting.participantIds], ["Plan the week", "operator", ["elin"]]);
    assert.equal((await post(`/api/meetings/${meeting.id}/messages`, { text: "Keep it short." })).statusCode, 201);
    // What the operator says in a meeting goes to the room, not to one staff member's chat.
    assert.equal((await post("/api/chat", { conversationId: meeting.id, text: "Hi" })).statusCode, 400);
    assert.equal((await post(`/api/meetings/${meeting.id}/approve`, { outcomeId: 99 })).statusCode, 404);
    await office.queue.idle();
    await office.meetings.idle();

    const ended = await post(`/api/meetings/${meeting.id}/end`);
    assert.equal(ended.json<Meeting>().state, "closed");
    assert.equal((await post(`/api/meetings/${meeting.id}/end`)).statusCode, 409);
    assert.equal((await post("/api/meetings/nobody/messages", { text: "Hi" })).statusCode, 404);
    assert.ok(office.snapshot().meetings.some((candidate) => candidate.id === meeting.id));
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

  it("gives and takes away web search, and refuses what isn't a site", async () => {
    let office: Office;
    ({ app, office } = await server());
    const url = "/api/agents/chief-of-staff/web";
    const given = await app.inject({ method: "PUT", url, headers: PAGE, payload: { sites: ["https://www.Reuters.com/world"] } });
    assert.equal(given.statusCode, 200);
    assert.deepEqual(given.json().web, { sites: ["www.reuters.com"] });
    assert.deepEqual(office.store.webGrantOf("chief-of-staff"), { sites: ["www.reuters.com"] });

    assert.equal((await app.inject({ method: "PUT", url, headers: PAGE, payload: { sites: ["no site"] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url, headers: PAGE, payload: { sites: "bbc.com" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/agents/nobody/web", headers: PAGE, payload: { sites: [] } })).statusCode, 404);
    assert.equal((await app.inject({ method: "PUT", url, headers: { ...PAGE, origin: "http://evil.example" }, payload: { sites: [] } })).statusCode, 403);

    const taken = await app.inject({ method: "DELETE", url, headers: PAGE, payload: {} });
    assert.equal(taken.statusCode, 200);
    assert.equal(taken.json().web, null);
  });

  it("turns weekend briefings on and off, and the standup", async () => {
    let office: Office;
    ({ app, office } = await server());
    const routine = office.store.listRoutines().find((candidate) => candidate.kind === "briefing")!;
    const standup = office.store.listRoutines().find((candidate) => candidate.kind === "standup")!;
    const patch = (payload: object, id = routine.id) => app!.inject({ method: "PATCH", url: `/api/routines/${id}`, headers: PAGE, payload });
    // A daemon without a scheduler runs no routines.
    assert.equal((await patch({ weekends: true })).statusCode, 409);

    // Saturday at 05:00 in Stockholm: today's briefing is next.
    office.scheduler = new Scheduler(office, { now: () => new Date("2026-11-14T04:00:00.000Z") });
    const daily = await patch({ weekends: true });
    assert.equal(daily.statusCode, 200);
    assert.deepEqual([daily.json().trigger, daily.json().nextRunAt], [{ type: "daily", time: "07:00" }, "2026-11-14T06:00:00.000Z"]);
    assert.deepEqual((await patch({ weekends: false })).json().trigger, { type: "weekdays", time: "07:00" });
    assert.equal((await patch({ weekends: "yes" })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/routines/nope", headers: PAGE, payload: { weekends: true } })).statusCode, 404);

    // The standup is off until the operator turns it on. The briefing can't be turned off.
    assert.equal(standup.paused, true);
    const on = await patch({ paused: false }, standup.id);
    assert.equal(on.statusCode, 200);
    assert.deepEqual([on.json().paused, on.json().nextRunAt], [false, "2026-11-16T08:00:00.000Z"], "Monday at 09:00");
    assert.equal((await patch({ paused: true })).statusCode, 400);
    assert.equal((await patch({})).statusCode, 400);
  });

  it("writes the office policy, and approves or declines proposals for it", async () => {
    let office: Office;
    ({ app, office } = await server());
    const put = (payload: object) => app!.inject({ method: "PUT", url: "/api/policy", headers: PAGE, payload });
    const written = await put({ body: "- Write in English." });
    assert.equal(written.statusCode, 200);
    assert.deepEqual([written.json().status, written.json().authorId], ["approved", null]);
    assert.equal((await put({ body: "- Write in English." })).statusCode, 400);
    assert.equal((await put({ text: "x" })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/policy", headers: { ...PAGE, origin: "http://evil.example" }, payload: { body: "x" } })).statusCode, 403);

    const basedOn = written.json().id;
    const pending = () => office.store.addPolicy({ body: `- Rule ${Math.random()}`, authorId: "chief-of-staff", reason: "Asked", basedOn, status: "pending", fromSourceData: false });
    const first = pending();
    const approved = await app.inject({ method: "POST", url: `/api/policy/${first.id}/approve`, headers: PAGE });
    assert.equal(approved.json().status, "approved");
    assert.equal((await app.inject({ method: "POST", url: `/api/policy/${first.id}/approve`, headers: PAGE })).statusCode, 409);

    const second = pending();
    const declined = await app.inject({ method: "POST", url: `/api/policy/${second.id}/decline`, headers: PAGE, payload: { reason: "Later" } });
    assert.deepEqual([declined.json().status, declined.json().outcome], ["declined", "Later"]);
    assert.equal((await app.inject({ method: "POST", url: "/api/policy/abc/approve", headers: PAGE })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/state", headers: PAGE })).json().policies.length, 3);
  });

  it("lists the models and sets what a staff member runs on", async () => {
    ({ app } = await server());
    const models = await app.inject({ url: "/api/models", headers: PAGE });
    assert.deepEqual(models.json().models.map((model: { id: string }) => model.id), ["fake-standard", "fake-light"]);

    const put = (payload: object, id = "chief-of-staff") => app!.inject({ method: "PUT", url: `/api/agents/${id}/model`, headers: PAGE, payload });
    const set = await put({ model: "fake-light", effort: "low" });
    assert.equal(set.statusCode, 200);
    assert.deepEqual([set.json().model, set.json().effort], ["fake-light", "low"]);
    assert.equal((await put({ model: "fake-light", effort: "high" })).statusCode, 400);
    assert.equal((await put({ model: "fake-light" })).statusCode, 400, "both fields, so a choice is never half-made");
    assert.equal((await put({ model: null, effort: null }, "nobody")).statusCode, 404);
    assert.equal((await app.inject({ method: "PUT", url: "/api/agents/chief-of-staff/model", headers: { ...PAGE, origin: "http://evil.example" }, payload: { model: null, effort: null } })).statusCode, 403);
    const reset = await put({ model: null, effort: null });
    assert.deepEqual([reset.json().model, reset.json().effort], [null, null]);
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

describe("HTTP server: decisions", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("approves and declines proposals, closes items, and ends responsibilities", async () => {
    let office: Office;
    ({ app, office } = await server());
    const { store } = office;
    const payload = {
      profile: { name: "Rut", title: "Bookkeeping Supervisor", description: "Keeps the books.", workingStyle: "" },
      responsibility: { title: "Books", scope: "", standingInstructions: "", expiresAt: null },
      source: null,
      reason: "Asked in chat",
    };
    const first = store.createProposal({ proposedBy: "chief-of-staff", runId: null, payload });
    const second = store.createProposal({ proposedBy: "chief-of-staff", runId: null, payload: { ...payload, profile: { ...payload.profile, name: "Ivar" } } });
    const post = (url: string, body?: object) => app!.inject({ method: "POST", url, headers: PAGE, ...(body && { payload: body }) });

    assert.equal((await post(`/api/proposals/${first.id}/approve`)).json().status, "approved");
    assert.equal((await post(`/api/proposals/${first.id}/approve`)).statusCode, 409);
    assert.equal((await post(`/api/proposals/${second.id}/decline`, { reason: "Later" })).json().outcome, "Later");
    assert.equal((await post("/api/proposals/nope/decline")).statusCode, 404);
    assert.equal((await post(`/api/proposals/${second.id}/approve`, { sourcePath: 42 })).statusCode, 400);

    const responsibility = store.activeResponsibilityOf("rut")!;
    const { item } = store.upsertItem({ responsibilityId: responsibility.id, sourceKey: "r-1", sourceVersion: "v1", title: "Receipt missing", detail: "", urgency: "fyi", expiresAt: null });
    const resolved = await post(`/api/items/${item.id}/resolve`, { note: "Found it" });
    assert.deepEqual([resolved.json().state, resolved.json().resolution], ["resolved", "Found it"]);
    assert.equal((await post(`/api/items/${item.id}/dismiss`)).statusCode, 409);
    assert.equal((await post("/api/items/999/dismiss")).statusCode, 404);
    const other = store.upsertItem({ responsibilityId: responsibility.id, sourceKey: "r-2", sourceVersion: "v1", title: "Old invoice", detail: "", urgency: "fyi", expiresAt: null }).item;
    assert.equal((await post(`/api/items/${other.id}/dismiss`, { note: 42 })).statusCode, 400);
    const dismissed = await post(`/api/items/${other.id}/dismiss`, { note: " Paid last year " });
    assert.deepEqual([dismissed.json().state, dismissed.json().resolution], ["dismissed", "Paid last year"]);

    assert.equal((await post(`/api/responsibilities/${responsibility.id}/end`)).json().status, "ended");
    assert.equal((await post(`/api/responsibilities/${responsibility.id}/end`)).statusCode, 409);
    assert.equal(store.getAgent("rut")!.state, "done");
  });

  it("approves and declines staff changes, and starts a staff review on request", async () => {
    let office: Office;
    ({ app, office } = await server());
    const { store } = office;
    const post = (url: string, body?: object) => app!.inject({ method: "POST", url, headers: PAGE, ...(body && { payload: body }) });
    assert.equal((await post("/api/staff-review")).statusCode, 409, "nobody to review yet");

    store.upsertAgent({ id: "nora", name: "Nora", title: "Calendar Supervisor", role: "supervisor", managerId: "chief-of-staff", profile: "data", charter: "" });
    const responsibility = store.createResponsibility({ ownerId: "nora", title: "Work calendar", scope: "All of it.", standingInstructions: "", expiresAt: null });
    const propose = (standingInstructions: string) =>
      store.createStaffChange({
        agentId: "nora",
        agentName: "Nora",
        responsibilityId: responsibility.id,
        change: { kind: "instructions", scope: "All of it.", standingInstructions, before: { scope: "All of it.", standingInstructions: "" } },
        reason: "Fewer findings.",
        proposedBy: "chief-of-staff",
        runId: null,
        fromSourceData: false,
      });
    const first = propose("Clashes only.");
    assert.equal((await post(`/api/staff-changes/${first.id}/approve`)).json().status, "approved");
    assert.equal(store.getResponsibility(responsibility.id)!.standingInstructions, "Clashes only.");
    assert.equal((await post(`/api/staff-changes/${first.id}/approve`)).statusCode, 409);
    const second = propose("Anything.");
    assert.equal((await post(`/api/staff-changes/${second.id}/decline`, { reason: "Keep it" })).json().outcome, "Keep it");
    assert.equal((await post("/api/staff-changes/nope/decline")).statusCode, 404);
    assert.ok((await app!.inject({ method: "GET", url: "/api/state", headers: PAGE })).json().staffChanges.some((change: { id: number }) => change.id === second.id));

    // A waiting change is withdrawn when the operator ends the responsibility.
    const third = propose("Something else.");
    await post(`/api/responsibilities/${responsibility.id}/end`);
    assert.equal(store.getStaffChange(third.id)!.status, "withdrawn");

    store.createResponsibility({ ownerId: "nora", title: "Reading list", scope: "", standingInstructions: "", expiresAt: null });
    assert.equal((await post("/api/staff-review")).statusCode, 202);
    await office.staffReview.idle();
    assert.ok(office.officeStats().staffReviewAt);
  });

  it("runs a routine on request", async () => {
    let office: Office;
    ({ app, office } = await server());
    const routine = office.store.listRoutines().find((candidate) => candidate.kind === "briefing")!;
    const run = () => app!.inject({ method: "POST", url: `/api/routines/${routine.id}/run`, headers: PAGE });
    assert.equal((await run()).statusCode, 409, "no scheduler");

    office.scheduler = new Scheduler(office, { briefing: () => new Promise(() => {}) });
    const started = await run();
    assert.equal(started.statusCode, 202);
    assert.match(started.json().occurrenceId, new RegExp(`^${routine.id}:manual:`));
    assert.equal((await run()).statusCode, 409, "already running");
    assert.equal((await app.inject({ method: "POST", url: "/api/routines/nope/run", headers: PAGE })).statusCode, 404);
  });

  it("answers a dashboard's data tools, and removes dashboards but not views under messages", async () => {
    let office: Office;
    ({ app, office } = await server());
    const { store } = office;
    const data = (body: unknown) => app!.inject({ method: "POST", url: "/api/views/data", headers: PAGE, payload: body as object });
    const staff = await data({ tool: "office_staff" });
    assert.equal(staff.statusCode, 200);
    assert.deepEqual(staff.json().rows.map((row: { name: string }) => row.name), ["Vera"]);
    assert.equal((await data({ tool: "office_items", args: { states: ["gone"] } })).statusCode, 400);
    assert.equal((await data({ tool: "send_mail", args: {} })).statusCode, 400);
    assert.equal((await data({})).statusCode, 400);

    const run = store.createRun({ agentId: "chief-of-staff", kind: "chat", title: "Reply" });
    const dashboard = store.addView({ kind: "dashboard", agentId: "chief-of-staff", runId: run.id, title: "Usage", program: "root = Stack([])", outside: "ask" });
    const reply = store.addView({ kind: "reply", agentId: "chief-of-staff", runId: run.id, title: "Prices", program: "root = Stack([])", outside: "ask" });
    const remove = (id: string) => app!.inject({ method: "DELETE", url: `/api/views/${id}`, headers: PAGE });
    assert.equal((await remove(dashboard.id)).statusCode, 204);
    assert.equal((await remove(dashboard.id)).statusCode, 404);
    assert.equal((await remove(reply.id)).statusCode, 409);
  });
});
