// A made-up mail service for the connector probe: an MCP server over HTTP behind its own OAuth
// server, with two mailboxes. It stands in for a real account, so the probe needs no sign-in.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestService {
  /** The MCP endpoint, as a service's config names it. */
  url: string;
  /** Who the next sign-in signs in as. */
  signInAs(email: string): void;
  /** Every request, in order, for the probe's report. */
  log: string[];
  /** Messages sent through `send_message`. */
  sent: Array<{ from: string; to: string; subject: string }>;
  /** How many times a client used a refresh token. */
  refreshes(): number;
  close(): Promise<void>;
}

const MAILBOXES: Record<string, Array<{ id: string; subject: string; from: string; receivedAt: string }>> = {
  "work@example.com": [
    { id: "m-101", subject: "Budget sign-off needed by Friday", from: "cfo@example.com", receivedAt: "2026-11-08T07:12:00Z" },
    { id: "m-102", subject: "Offsite agenda", from: "team@example.com", receivedAt: "2026-11-07T15:40:00Z" },
  ],
  "home@example.com": [{ id: "m-201", subject: "Your library loan is due Thursday", from: "library@example.org", receivedAt: "2026-11-08T06:02:00Z" }],
};

export const TOOLS = [
  {
    name: "whoami",
    description: "The signed-in account's address.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_messages",
    description: "Messages in the inbox, newest first.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    outputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, subject: { type: "string" }, from: { type: "string" }, receivedAt: { type: "string" }, link: { type: "string" } },
            required: ["id", "subject", "from", "receivedAt", "link"],
          },
        },
      },
      required: ["messages"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "send_message",
    description: "Sends a message from the signed-in account.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" } }, required: ["to", "subject"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "tidy_inbox",
    description: "Tidies the inbox. Carries no annotations, like many real tools.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function startTestService(options: { tokenLifetimeSeconds: number }): Promise<TestService> {
  const log: string[] = [];
  const sent: TestService["sent"] = [];
  let nextUser = "work@example.com";
  let refreshCount = 0;
  const clients = new Set<string>();
  const codes = new Map<string, { user: string; challenge: string; redirectUri: string }>();
  const accessTokens = new Map<string, { user: string; expiresAt: number }>();
  const refreshTokens = new Map<string, string>();

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      log.push(`error ${String(error)}`);
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function issue(user: string) {
    const access = `at-${randomUUID()}`;
    const refresh = `rt-${randomUUID()}`;
    accessTokens.set(access, { user, expiresAt: Date.now() + options.tokenLifetimeSeconds * 1000 });
    refreshTokens.set(refresh, user);
    return { access_token: access, token_type: "Bearer", expires_in: options.tokenLifetimeSeconds, refresh_token: refresh };
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    const body = await readBody(request);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      log.push(`GET ${url.pathname}`);
      return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
      log.push(`GET ${url.pathname}`);
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      const registration = JSON.parse(body || "{}") as { redirect_uris?: string[]; client_name?: string };
      const clientId = `client-${randomUUID()}`;
      clients.add(clientId);
      log.push(`register ${registration.client_name ?? "unnamed"} ${JSON.stringify(registration.redirect_uris ?? [])}`);
      return json(201, {
        ...registration,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }
    if (url.pathname === "/authorize") {
      // Signs in at once as whoever the probe chose: there is no one to click.
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      log.push(`authorize ${nextUser} scope=${url.searchParams.get("scope") ?? ""} pkce=${url.searchParams.get("code_challenge_method") ?? "none"}`);
      if (!clients.has(clientId) || !redirectUri) return json(400, { error: "invalid_request" });
      const code = `code-${randomUUID()}`;
      codes.set(code, { user: nextUser, challenge, redirectUri });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) target.searchParams.set("state", state);
      return response.writeHead(302, { location: target.toString() }).end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (!code || code.challenge !== expected) {
          log.push("token refused: bad code or PKCE");
          return json(400, { error: "invalid_grant" });
        }
        log.push(`token for ${code.user}`);
        return json(200, issue(code.user));
      }
      if (grant === "refresh_token") {
        const user = refreshTokens.get(form.get("refresh_token") ?? "");
        refreshTokens.delete(form.get("refresh_token") ?? "");
        if (!user) {
          log.push("refresh refused");
          return json(400, { error: "invalid_grant" });
        }
        refreshCount++;
        log.push(`refresh for ${user}`);
        return json(200, issue(user));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        log.push(`${request.method} /mcp`);
        return response.writeHead(405, { allow: "POST" }).end();
      }
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const session = token ? accessTokens.get(token) : undefined;
      if (!session || session.expiresAt < Date.now()) {
        log.push(`mcp 401 (${token ? "expired or unknown token" : "no token"})`);
        return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      }
      const message = JSON.parse(body) as { id?: number | string; method: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
      log.push(`mcp ${message.method}${message.params?.name ? ` ${message.params.name}` : ""} as ${session.user}`);
      if (message.id === undefined) return response.writeHead(202).end();
      const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: message.id, result });
      switch (message.method) {
        case "initialize":
          return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-mail", version: "1.0.0" } });
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call":
          return reply(callTool(session.user, message.params?.name ?? "", message.params?.arguments ?? {}));
        case "ping":
          return reply({});
        default:
          return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `No method ${message.method}` } });
      }
    }
    log.push(`404 ${url.pathname}`);
    response.writeHead(404).end();
  }

  function callTool(user: string, name: string, args: Record<string, unknown>) {
    const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    switch (name) {
      case "whoami":
        return text({ email: user });
      case "list_messages": {
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const messages = (MAILBOXES[user] ?? []).slice(0, limit).map((message) => ({ ...message, link: `https://mail.example.com/${encodeURIComponent(user)}/${message.id}` }));
        return text({ messages });
      }
      case "send_message":
        sent.push({ from: user, to: String(args.to), subject: String(args.subject) });
        return text({ sent: true });
      case "tidy_inbox":
        return text({ tidied: 0 });
      default:
        return { content: [{ type: "text", text: `No tool ${name}` }], isError: true };
    }
  }

  return {
    url: `${origin}/mcp`,
    signInAs: (email) => (nextUser = email),
    log,
    sent,
    refreshes: () => refreshCount,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
