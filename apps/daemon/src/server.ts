import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import fastifyStatic from "@fastify/static";
import type { ChatResponse, HealthResponse, StateSnapshot } from "@aihub/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { SequencedEvent } from "./events.ts";
import { NotFoundError, type Office } from "./office.ts";

export interface ServerOptions {
  office: Office;
  version: string;
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

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { office } = options;
  const startedAt = new Date().toISOString();
  const app = Fastify({ logger: options.logger ?? true });

  const port = () => options.port ?? (app.server.address() as AddressInfo | null)?.port;

  // DNS rebinding protection: only answer requests addressed to the loopback daemon itself.
  app.addHook("onRequest", async (request, reply) => {
    const allowed = [`127.0.0.1:${port()}`, `localhost:${port()}`];
    if (!allowed.includes(request.headers.host ?? "")) {
      return reply.code(421).send({ error: "Unexpected Host header" });
    }
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
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  // Server-sent events. A client loads /api/state, then follows from that snapshot's lastEventId.
  // EventSource sends Last-Event-ID itself when it reconnects.
  app.get<{ Querystring: { after?: string } }>("/api/events", (request, reply) => {
    const after = String(request.headers["last-event-id"] ?? request.query.after ?? office.bus.lastEventId);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });

    const backlog = office.bus.after(after);
    if (backlog === null) {
      response.end(`data: ${JSON.stringify({ type: "resync" })}\n\n`);
      return;
    }
    const send = ({ id, event }: SequencedEvent) => response.write(`id: ${office.bus.format(id)}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of backlog) send(event);
    const unsubscribe = office.bus.subscribe(send);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), options.heartbeatMs ?? 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
