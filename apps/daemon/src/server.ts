import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import fastifyStatic from "@fastify/static";
import type {
  AccessResponse,
  Agent,
  AppsResponse,
  ChatResponse,
  HealthResponse,
  Meeting,
  ModelsResponse,
  Note,
  NoteSummary,
  OpenChatResponse,
  PolicyVersion,
  Service,
  ServiceSignInResponse,
  SourcePreview,
  StaffChange,
  StateSnapshot,
} from "@aihub/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { SequencedEvent } from "./events.ts";
import { NoteRefusal } from "./notes/notebook.ts";
import { checkNotePath } from "./notes/vault.ts";
import { ConflictError, InvalidRequestError, NotFoundError } from "./errors.ts";
import type { Office } from "./office.ts";
import { approveProposal, declineProposal, previewProposal } from "./staff/proposals.ts";
import { approvePolicy, declinePolicy, writePolicy } from "./staff/policy.ts";
import { approveStaffChange, declineStaffChange, withdrawStaffChanges } from "./staff/staff-changes.ts";
import { registerLoopbackGuards } from "./security.ts";
import { answerData } from "./views/data.ts";

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
  /** Fastify's logger: on, off, or options such as a stream for the background daemon's log file. */
  logger?: FastifyServerOptions["logger"];
  heartbeatMs?: number;
  /**
   * Stops the daemon. Given only to the background daemon, so the tray icon's Quit and
   * `npm run windows` can stop it cleanly instead of ending its process.
   */
  onQuit?: () => void;
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
const TopicBody = z.object({ title: z.string().max(200).optional() }).strict();
const RenameBody = z.object({ title: z.string().trim().min(1).max(200) }).strict();
const MeetingBody = z.object({ agenda: z.string().trim().min(1).max(4_000), participantIds: z.array(z.string().min(1).max(80)).max(32).optional() }).strict();
const SayBody = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();
const OutcomeBody = z.object({ outcomeId: z.number().int().positive() }).strict();
const WebBody = z.object({ sites: z.array(z.string().max(200)).max(50), live: z.boolean().optional() }).strict();
const RoutineBody = z.object({ weekends: z.boolean() }).strict();
const PolicyBody = z.object({ body: z.string().max(20_000) }).strict();
const ModelBody = z.object({ model: z.string().trim().min(1).max(80).nullable(), effort: z.string().trim().min(1).max(20).nullable() }).strict();
const UnsafeTicks = z.array(z.string().max(300)).max(40).optional();
const ApproveBody = z.object({ sourcePath: z.string().max(1_000).optional(), unsafe: UnsafeTicks }).strict();
const PreviewBody = z.object({ sourcePath: z.string().max(1_000).default("") }).strict();
/** For a service or a staff change: the unsafe grants the operator ticked. */
const ApproveServiceBody = z.object({ unsafe: UnsafeTicks }).strict();
const ReasonBody = z.object({ reason: z.string().max(500).optional() }).strict();
const CloseItemBody = z.object({ note: z.string().max(500).optional() }).strict();
const ViewDataBody = z.object({ tool: z.string().trim().min(1).max(60), args: z.record(z.string(), z.unknown()).optional() }).strict();

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

/** A numeric record id from the URL, such as a policy version's. Anything else names no record. */
function numericId(raw: string, what: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new NotFoundError(`No ${what} ${raw}`);
  return id;
}

function policyId(raw: string): number {
  return numericId(raw, "policy proposal");
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

  const { onQuit } = options;
  if (onQuit) {
    app.post("/api/quit", async (_request, reply) => {
      // Stopping closes this server, so the answer goes out first.
      setTimeout(onQuit, 100);
      return reply.code(202).send({ status: "stopping" });
    });
  }

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

  app.post<{ Params: { id: string } }>("/api/agents/:id/topics", async (request, reply) => {
    const body = TopicBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    try {
      const response: OpenChatResponse = { conversation: office.startTopic(request.params.id, body.data.title) };
      return reply.code(201).send(response);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const body = RenameBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    try {
      const response: OpenChatResponse = { conversation: office.renameTopic(request.params.id, body.data.title) };
      return response;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Meetings (DESIGN.md › Meetings): the operator calls one, speaks in it, approves its conclusion, or ends it.
  app.post("/api/meetings", async (request, reply) => {
    const body = bodyOf(MeetingBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const meeting: Meeting = office.meetings.call({ ...body.data, calledBy: "operator" });
      return reply.code(201).send(meeting);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/meetings/:id/messages", async (request, reply) => {
    const body = bodyOf(SayBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return reply.code(201).send({ message: office.meetings.say(request.params.id, body.data.text) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/meetings/:id/approve", async (request, reply) => {
    const body = bodyOf(OutcomeBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const meeting: Meeting = office.meetings.approve(request.params.id, body.data.outcomeId);
      return meeting;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/meetings/:id/end", async (request, reply) => {
    try {
      const meeting: Meeting = office.meetings.end(request.params.id);
      return meeting;
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

  // Web search is a grant the operator gives (DESIGN.md › Authority and data boundaries).
  app.put<{ Params: { id: string } }>("/api/agents/:id/web", async (request, reply) => {
    const body = bodyOf(WebBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const agent: Agent = office.setWebGrant(request.params.id, body.data);
      return agent;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // What staff run on (DESIGN.md › Staff and work model).
  app.get("/api/models", async (_request, reply) => {
    try {
      const response: ModelsResponse = { models: await office.models() };
      return response;
    } catch (error) {
      return sendError(reply, new ConflictError(`Codex's list of models isn't available right now: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  app.put<{ Params: { id: string } }>("/api/agents/:id/model", async (request, reply) => {
    const body = bodyOf(ModelBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const agent: Agent = await office.setModel(request.params.id, body.data);
      return agent;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id/web", async (request, reply) => {
    try {
      const agent: Agent = office.setWebGrant(request.params.id, null);
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

  app.post<{ Params: { id: string } }>("/api/proposals/:id/preview", async (request, reply) => {
    const body = bodyOf(PreviewBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const preview: SourcePreview = await previewProposal(office, request.params.id, body.data.sourcePath);
      return preview;
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

  // Services (DESIGN.md › Connectors and capabilities): the operator approves, signs in, checks, and removes them.
  app.get<{ Querystring: { refresh?: string } }>("/api/services/apps", async (request, reply) => {
    try {
      const response: AppsResponse = { apps: await office.services.apps(request.query.refresh === "1") };
      return response;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/approve", async (request, reply) => {
    const body = bodyOf(ApproveServiceBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const service: Service = await office.services.approve(request.params.id, body.data.unsafe ?? []);
      return service;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/decline", async (request, reply) => {
    const body = bodyOf(ReasonBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const service: Service = office.services.decline(request.params.id, body.data.reason);
      return service;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/sign-in", async (request, reply) => {
    try {
      const response: ServiceSignInResponse = await office.services.signIn(request.params.id);
      return response;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/refresh", async (request, reply) => {
    try {
      const service: Service = await office.services.refresh(request.params.id);
      return service;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/remove", async (request, reply) => {
    try {
      const service: Service = office.services.remove(request.params.id);
      return service;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // The Access panel: what staff can reach, beyond what the snapshot holds.
  app.get("/api/access", async () => {
    const response: AccessResponse = {
      staff: office.store.listAgents().map((agent) => ({ agentId: agent.id, kinds: office.gateway.toolsByKind(agent.id) })),
    };
    return response;
  });

  app.delete<{ Params: { id: string } }>("/api/service-grants/:id", async (request, reply) => {
    try {
      office.services.revokeGrant(numericId(request.params.id, "grant"));
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; agentId: string } }>("/api/connections/:id/grants/:agentId", async (request, reply) => {
    try {
      office.revokeSource(request.params.id, request.params.agentId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/items/:id/dismiss", async (request, reply) => {
    const body = bodyOf(CloseItemBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return office.closeItem(Number(request.params.id), "dismissed", body.data.note?.trim() || null);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/items/:id/resolve", async (request, reply) => {
    const body = bodyOf(CloseItemBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return office.closeItem(Number(request.params.id), "resolved", body.data.note?.trim() || null);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Views (DESIGN.md › Views): a dashboard fetches read-only office data, and the operator removes dashboards.
  app.post("/api/views/data", async (request, reply) => {
    const body = bodyOf(ViewDataBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      return await answerData(office, body.data.tool, body.data.args ?? {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/views/:id", async (request, reply) => {
    try {
      office.views.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/responsibilities/:id/end", async (request, reply) => {
    try {
      const responsibility = office.endResponsibility(request.params.id);
      withdrawStaffChanges(office, responsibility.ownerId, "You ended the responsibility yourself.");
      return responsibility;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Staff changes from the Chief of Staff's review (DESIGN.md › Staff review): the operator approves or declines each.
  app.post<{ Params: { id: string } }>("/api/staff-changes/:id/approve", async (request, reply) => {
    try {
      const body = bodyOf(ApproveServiceBody, request.body ?? {});
      if (!body.ok) return reply.code(400).send({ error: body.error });
      const change: StaffChange = await approveStaffChange(office, numericId(request.params.id, "staff change"), body.data.unsafe ?? []);
      return change;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/staff-changes/:id/decline", async (request, reply) => {
    const body = bodyOf(ReasonBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const change: StaffChange = declineStaffChange(office, numericId(request.params.id, "staff change"), body.data.reason?.trim() || null);
      return change;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // The operator asks for a staff review now. It runs in the background; its message and cards arrive in the Chief of Staff's chat.
  app.post("/api/staff-review", async (_request, reply) => {
    try {
      const review = office.staffReview.run();
      review.catch((error: unknown) => app.log.error({ err: error }, "The staff review failed"));
      return reply.code(202).send({ started: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // The office policy: the operator writes it, or approves or declines the Chief of Staff's proposal.
  app.put("/api/policy", async (request, reply) => {
    const body = bodyOf(PolicyBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const policy: PolicyVersion = writePolicy(office, body.data.body);
      return policy;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/policy/:id/approve", async (request, reply) => {
    try {
      const policy: PolicyVersion = approvePolicy(office, policyId(request.params.id));
      return policy;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/policy/:id/decline", async (request, reply) => {
    const body = bodyOf(ReasonBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      const policy: PolicyVersion = declinePolicy(office, policyId(request.params.id), body.data.reason?.trim() || null);
      return policy;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/routines/:id", async (request, reply) => {
    const body = bodyOf(RoutineBody, request.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    try {
      if (!office.scheduler) throw new ConflictError("This daemon runs no routines.");
      return office.scheduler.setWeekends(request.params.id, body.data.weekends);
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
