import { spawn } from "node:child_process";

// Runs Windows' own tools (schtasks, reg, powershell) and collects what they say. Nothing here
// throws: a tool that can't start or times out comes back as a failed result for the caller to log.

export interface ExecResult {
  /** Null when the tool didn't start or was stopped. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: error ? `${stderr}${error}` : stderr });
    };
    const child = spawn(command, args, { env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `${command} took longer than ${options.timeoutMs} ms and was stopped`);
    }, options.timeoutMs ?? 30_000);
  });

/** The first line worth showing from a failed tool, for the log. */
export function failure(result: ExecResult): string {
  const line = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find(Boolean);
  return line ?? (result.code === null ? "it didn't run" : `exit code ${result.code}`);
}
