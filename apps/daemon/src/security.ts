import { randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store/store.ts";

// Loopback hardening (DESIGN.md › Architecture). Loopback keeps other machines out but not other
// pages open in the operator's browser, so every request must pass three checks:
// 1. Host is the daemon itself, which blocks DNS rebinding.
// 2. State-changing requests come from the AiHub UI's origin.
// 3. API and event-stream requests carry the per-install token, held in a SameSite=Strict cookie
//    that only a same-origin page can obtain from GET /api/session.
// No CORS headers are ever sent, so other origins cannot read responses either.

/**
 * The page runs only AiHub's own scripts and talks only to the daemon. Images may come from the web,
 * for views (DESIGN.md › Views): AiHub's components decide whether an outside image loads by itself or
 * waits for the operator's click. Nothing else loads from outside, and nothing frames the page.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const TOKEN_COOKIE = "aihub_token";
const TOKEN_SETTING = "install_token";
const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** Reachable without the token: the page's own way of getting one. */
const PUBLIC_PATHS = new Set(["/api/session"]);

export interface LoopbackGuardOptions {
  /** The port the daemon listens on. */
  port: () => number | undefined;
  /** Extra UI origins, such as the Vite dev server, allowed to make state-changing requests. */
  devOrigins: string[];
  token: string;
}

/**
 * The install token, read without opening the office: no migrations run, so a newer checkout's
 * commands never change the database under the daemon that is running.
 */
export function readInstallToken(dbPath: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(TOKEN_SETTING) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    // A database without the settings table has no token to give.
    return null;
  } finally {
    db.close();
  }
}

/** The per-install token, generated on first start and kept in SQLite. */
export function installToken(store: Store): string {
  let token = store.getSetting(TOKEN_SETTING);
  if (!token) {
    token = randomBytes(32).toString("base64url");
    store.setSetting(TOKEN_SETTING, token);
  }
  return token;
}

export function registerLoopbackGuards(app: FastifyInstance, options: LoopbackGuardOptions) {
  const expected = Buffer.from(options.token);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    reply.header("x-content-type-options", "nosniff");

    const port = options.port();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host ?? "")) {
      return reply.code(421).send({ error: "Unexpected Host header" });
    }

    if (!SAFE_METHODS.has(request.method)) {
      const origins = [...hosts.map((host) => `http://${host}`), ...options.devOrigins];
      if (!origins.includes(request.headers.origin ?? "")) {
        return reply.code(403).send({ error: "Unexpected Origin" });
      }
    }

    // The matched route's pattern, not the raw URL, so no spelling of a path can skip the check.
    const route = request.routeOptions.url ?? "";
    if (route.startsWith("/api/") && !PUBLIC_PATHS.has(route)) {
      const token = Buffer.from(cookie(request, TOKEN_COOKIE) ?? "");
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
        return reply.code(401).send({ error: "Missing or invalid AiHub token. Reload the page." });
      }
    }
  });

  // Browsers mark requests from other sites with Sec-Fetch-Site, which pages cannot forge. Only a
  // page on the AiHub origin itself, or the operator typing the address, gets the token.
  app.get("/api/session", async (request, reply) => {
    const site = request.headers["sec-fetch-site"];
    if (site !== "same-origin" && site !== "none") {
      return reply.code(403).send({ error: "The AiHub token is only given to the AiHub page" });
    }
    reply.header(
      "set-cookie",
      `${TOKEN_COOKIE}=${options.token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${10 * 365 * 24 * 3600}`,
    );
    return { ok: true };
  });
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}
