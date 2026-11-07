import Fastify from "fastify";
import type { HealthResponse } from "@aihub/shared";
import pkg from "../package.json" with { type: "json" };

// The daemon only listens on loopback (DESIGN.md › Architecture).
const HOST = "127.0.0.1";
const PORT = Number(process.env.AIHUB_PORT ?? 7420);
const startedAt = new Date().toISOString();

const app = Fastify({ logger: true });

// Loopback hardening, first part: reject any Host header that is not this daemon,
// which blocks DNS rebinding. Origin checks and the per-install token come with Milestone 1.
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
app.addHook("onRequest", async (request, reply) => {
  if (!allowedHosts.has(request.headers.host ?? "")) {
    return reply.code(421).send({ error: "Unexpected Host header" });
  }
});

app.get("/api/health", async (): Promise<HealthResponse> => ({
  status: "ok",
  version: pkg.version,
  startedAt,
}));

await app.listen({ host: HOST, port: PORT });
