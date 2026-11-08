import { request } from "node:http";
import { TOKEN_COOKIE } from "./security.ts";

// Who answers on AiHub's port. One daemon serves an office: a second copy, such as the one the wake
// task starts while the daemon already runs, finds the port taken, asks who has it, and leaves.

export type Answer =
  /** Nothing listens on the port. */
  | { kind: "none" }
  /** This office's daemon: it accepted this install's token. */
  | { kind: "aihub"; version: string; startedAt: string }
  /** An AiHub with another data folder, whose token differs. */
  | { kind: "other-aihub" }
  | { kind: "other"; detail: string };

export function askHealth(port: number, token: string | null, timeoutMs = 3_000): Promise<Answer> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health",
        headers: token ? { cookie: `${TOKEN_COOKIE}=${token}` } : {},
        timeout: timeoutMs,
        // A fresh connection each time: a kept-alive one could belong to a daemon that has since stopped.
        agent: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk.slice(0, 4_096)));
        response.on("end", () => resolve(readAnswer(response.statusCode ?? 0, body)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ECONNREFUSED" ? { kind: "none" } : { kind: "other", detail: error.message }),
    );
    req.end();
  });
}

/** Asks this office's background daemon to stop. True when it agreed. */
export function askToQuit(port: number, token: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const origin = `http://127.0.0.1:${port}`;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/quit",
        headers: { cookie: `${TOKEN_COOKIE}=${token}`, origin, "content-length": 0 },
        timeout: timeoutMs,
        agent: false,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 202);
      },
    );
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", () => resolve(false));
    req.end();
  });
}

function readAnswer(status: number, body: string): Answer {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Not JSON, so not AiHub.
  }
  if (status === 200 && json.status === "ok" && typeof json.version === "string") {
    return { kind: "aihub", version: json.version, startedAt: String(json.startedAt ?? "") };
  }
  if (status === 401 && typeof json.error === "string" && json.error.includes("AiHub")) return { kind: "other-aihub" };
  return { kind: "other", detail: `HTTP ${status}` };
}
