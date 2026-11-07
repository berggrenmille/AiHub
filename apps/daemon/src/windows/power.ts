import type { Exec } from "./exec.ts";
import { systemTool } from "./names.ts";

// Whether the power plan lets the wake task wake the PC. Windows ignores "Wake the computer to run
// this task" when the plan's "Allow wake timers" is off, separately on AC power and on battery.

export type WakeTimers = "allowed" | "off" | "important only" | "unknown";

const VALUES: Record<number, WakeTimers> = { 0: "off", 1: "allowed", 2: "important only" };

/**
 * Reads `powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE`. Its labels are in the system's language,
 * but the setting ends with two hex values, the current index on AC power and then on battery.
 */
export function parseWakeTimers(output: string): { ac: WakeTimers; dc: WakeTimers } | null {
  const values = [...output.matchAll(/0x([0-9a-f]{8})/gi)].map((match) => parseInt(match[1]!, 16));
  if (values.length < 2) return null;
  const [ac, dc] = values.slice(-2) as [number, number];
  return { ac: VALUES[ac] ?? "unknown", dc: VALUES[dc] ?? "unknown" };
}

export async function wakeTimers(exec: Exec): Promise<{ ac: WakeTimers; dc: WakeTimers } | null> {
  const result = await exec(systemTool("powercfg.exe"), ["/q", "SCHEME_CURRENT", "SUB_SLEEP", "RTCWAKE"], { timeoutMs: 15_000 });
  return result.code === 0 ? parseWakeTimers(result.stdout) : null;
}
