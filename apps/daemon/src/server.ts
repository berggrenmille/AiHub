import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import fastifyStatic from "@fastify/static";
import type { Agent, ChatResponse, HealthResponse, Note, NoteSummary, OpenChatResponse, StateSnapshot } from "@aihub/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { SequencedEvent } from "./events.ts";
import { NoteRefusal } from "./notes/notebook.ts";
import { checkNotePath } from "./notes/vault.ts";
import { ConflictError, InvalidRequestError, NotFoundError } from "./errors.ts";
import type { Office } from "./office.ts";
import { approveProposal, declineProposal } from "./staff/proposals.ts";
import { registerLoopbackGuards } from "./security.ts";

export interface ServerOptions {
  office: Office;
  version: string;
  /** The per-install token every API request must carry. */
  token: string;
  /** Extra UI origins allowed to make state-changing requests, such as the Vite dev server. */
  devOrigins?: string[];
  /** The port the daemon listens on. Defaults to the port it actually bound, which tests use. */
  port?: number;
  /** The built web UI, served at `/` when it exists. */
  webRoot?: string;
  logger?: boolean;
  heartbeatMs?: number;
}

const ChatBody = z.object({
  conversationId: z.string().min(1),
  text: z.string().trim().min(1).max(20_000),
});

const ProfileBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    title: z.string().trim().max(60),
    description: z.string().trim().max(400),
    workingStyle: z.string().trim().max(200),
  })
  .partial()
  .strict()
  .refine((profile) => Object.keys(profile).length > 0, "Change at least one field");

const NoteBody = z.object({ body: z.string().max(20_000) }).strict();
const ApproveBody = z.object({ sourcePath: z.string().max(1_000).optional() }).strict();
const ReasonBody = z.object({ reason: z.string().max(500).optional() }).strict();
const ResolveBody = z.object({ note: z.string().max(500).optional() }).strict();

/** Parses an optional JSON body: a POST without one counts as `{}`. */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(body ?? {});
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

/** Answers with the status a domain error means, or rethrows anything else. */
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof ConflictError || error instanceof NoteRefusal) return reply.code(409).send({ error: error.message });
  if (error instanceof InvalidRequestError) return reply.code(400).send({ error: error.message });
  throw error;
}

function notePath(raw: string): string | null {
  try {
    return checkNotePath(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { office } = options;
  const startedAt = new Date().toISOString();
  // On shutdown, drop connections instead of waiting for browsers to close their idle sockets.
  const app = Fastify({ logger: options.logger ?? true, forceCloseConnections: true });

  registerLoopbackGuards(app, {
    port: () => options.port ?? (app.server.address() as AddressInfo | null)?.port,
    devOrigins: options.devOrigins ?? [],
    token: options.token,
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({ status: "ok", version: options.version, startedAt }));

  app.get("/api/state", async (): Promise<StateSnapshot> => office.snapshot());

  app.post("/api/chat", async (request, reply) => {
    const body = ChatBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    try {
      const response: ChatResponse = office.chat(body.data.conversationId, body.data.text);
      return reply.code(202).send(response);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/chat", async (request, reply) => {
    try {
      const response: OpenChatResponse = { conversation: office.openChat(request.params.id) };
      return response;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const body = ProfileBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    try {
      const agent: Agent = office.updateProfile(request.params.id, body.data);
      return agent;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/approve", async (request, reply) => {
    const body = bodyOf(ApproveBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return await approveProposal(office, request.params.id, body.data);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/decline", async (request, reply) => {
    const body = bodyOf(ReasonBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return declineProposal(office, request.params.id, body.data.reason);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/items/:id/dismiss", async (request, reply) => {
    try {
      return office.closeItem(Number(request.params.id), "dismissed", null);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/items/:id/resolve", async (request, reply) => {
    const body = bodyOf(ResolveBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return office.closeItem(Number(request.params.id), "resolved", body.data.note?.trim() || null);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/responsibilities/:id/end", async (request, reply) => {
    try {
      return office.endResponsibility(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/routines/:id/run", async (request, reply) => {
    try {
      if (!office.scheduler) throw new ConflictError("This daemon runs no routines.");
      return reply.code(202).send({ occurrenceId: office.scheduler.runNow(request.params.id) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Notes live at their vault path, such as /api/notes/Staff/chief-of-staff/Vera.md.
  app.get<{ Params: { "*": string } }>("/api/notes/*", async (request, reply) => {
    const path = notePath(request.params["*"]);
    if (!path) return reply.code(400).send({ error: "Not a note path" });
    const note: Note | null = office.notebook.read(path);
    return note ?? reply.code(404).send({ error: `No note at ${path}` });
  });

  app.put<{ Params: { "*": string } }>("/api/notes/*", async (request, reply) => {
    const path = notePath(request.params["*"]);
    if (!path) return reply.code(400).send({ error: "Not a note path" });
    const body = NoteBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    try {
      const note: NoteSummary = office.notebook.writeByOperator(path, body.data.body);
      return note;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Server-sent events. A client loads /api/state, then follows from that snapshot's lastEventId.
  // EventSource sends Last-Event-ID itself when it reconnects. Open streams are ended on shutdown,
  // which would otherwise wait for every browser tab to disconnect.
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of streams) end();
  });

  app.get<{ Querystring: { after?: string } }>("/api/events", (request, reply) => {
    const after = String(request.headers["last-event-id"] ?? request.query.after ?? office.bus.lastEventId);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Start the body now, not with the first event, so the browser sees the stream open even
    // through a proxy that holds the headers until data arrives. EventSource ignores comments.
    response.write(": open\n\n");

    const backlog = office.bus.after(after);
    if (backlog === null) {
      response.end(`data: ${JSON.stringify({ type: "resync" })}\n\n`);
      return;
    }
    const send = ({ id, event }: SequencedEvent) => response.write(`id: ${office.bus.format(id)}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of backlog) send(event);
    const unsubscribe = office.bus.subscribe(send);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), options.heartbeatMs ?? 15_000);
    const end = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(end);
      response.end();
    };
    streams.add(end);
    request.raw.on("close", end);
  });

  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
