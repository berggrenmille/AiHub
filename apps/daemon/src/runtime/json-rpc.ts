import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClientRequest, RequestId, ServerNotification, ServerRequest } from "@aihub/codex-protocol";

export type ParamsOf<M extends ClientRequest["method"]> = Extract<ClientRequest, { method: M }>["params"];

export type ServerRequestReply = { result: unknown } | { error: { code: number; message: string } };

type Incoming = {
  id?: RequestId;
  method?: string;
  result?: unknown;
  error?: { message: string };
};

/** JSON-RPC over a child process's stdio, one JSON message per line, as Codex App Server speaks it. */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: {
      onServerRequest: (request: ServerRequest) => Promise<ServerRequestReply>;
      onNotification: (notification: ServerNotification) => void;
      onClose: (reason: string) => void;
    },
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.on("exit", (code, signal) => this.close(`exited with ${signal ?? `code ${code}`}`));
    child.on("error", (error) => this.close(error.message));
  }

  request<M extends ClientRequest["method"]>(method: M, params: ParamsOf<M>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(message: object) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string) {
    if (!line.trim()) return;
    let message: Incoming;
    try {
      message = JSON.parse(line) as Incoming;
    } catch {
      return; // Not protocol output.
    }
    if (message.method === undefined && message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else if (message.id !== undefined) {
      const request = message as ServerRequest;
      this.handlers
        .onServerRequest(request)
        .catch((error: unknown) => ({ error: { code: -32603, message: String(error) } }))
        .then((reply) => this.send({ id: request.id, ...reply }));
    } else if (message.method !== undefined) {
      this.handlers.onNotification(message as ServerNotification);
    }
  }

  private close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error(`Codex App Server ${reason}`));
    this.pending.clear();
    this.handlers.onClose(reason);
  }
}
