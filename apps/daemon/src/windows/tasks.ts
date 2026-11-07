import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, type Exec, type ExecResult } from "./exec.ts";
import { systemTool } from "./names.ts";

// Task Scheduler through schtasks.exe, which registers a task for the current user without
// elevation. Its messages are in the system's language, so only exit codes and XML are read.

function schtasks(exec: Exec, args: string[]): Promise<ExecResult> {
  return exec(systemTool("schtasks.exe"), args, { timeoutMs: 30_000 });
}

/** Creates the task, or replaces it. A running copy of the task's program keeps running. */
export async function registerTask(exec: Exec, name: string, xml: string): Promise<ExecResult> {
  // schtasks reads a definition only from a file, and only as UTF-16.
  const file = join(tmpdir(), `aihub-task-${randomBytes(6).toString("hex")}.xml`);
  writeFileSync(file, `﻿${xml}`, "utf16le");
  try {
    return await schtasks(exec, ["/Create", "/TN", name, "/XML", file, "/F"]);
  } finally {
    rmSync(file, { force: true });
  }
}

/** The task's definition as XML, or null when there is no such task. */
export async function queryTask(exec: Exec, name: string): Promise<string | null> {
  const result = await schtasks(exec, ["/Query", "/TN", name, "/XML"]);
  return result.code === 0 ? result.stdout : null;
}

/** Removes the task. Fine when it was never there; fails only when the task is still there after. */
export async function deleteTask(exec: Exec, name: string): Promise<ExecResult> {
  const result = await schtasks(exec, ["/Delete", "/TN", name, "/F"]);
  if (result.code === 0 || (await queryTask(exec, name)) === null) return { ...result, code: 0 };
  return result;
}

export function runTask(exec: Exec, name: string): Promise<ExecResult> {
  return schtasks(exec, ["/Run", "/TN", name]);
}

/** The signed-in user's SID, which tasks run as. whoami gives it the same way in every language. */
export async function currentUserSid(exec: Exec): Promise<string> {
  const result = await exec(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { timeoutMs: 15_000 });
  const sid = /"(S-1-[\d-]+)"/.exec(result.stdout)?.[1];
  if (!sid) throw new Error(`whoami didn't give the user's SID: ${failure(result)}`);
  return sid;
}

/** Reads one element's text from a task definition, such as StartBoundary. */
export function taskElement(xml: string, element: string): string | null {
  return new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml)?.[1] ?? null;
}
