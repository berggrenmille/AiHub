import type { Exec, ExecResult } from "./exec.ts";
import { systemTool } from "./names.ts";

// Notifications show under an app id. Registered under the operator's own registry hive, with a
// name and an icon, the toast says "AiHub" rather than "Windows PowerShell", and no elevation or
// Start menu shortcut is needed.

export function appIdKey(appId: string): string {
  return `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
}

function reg(exec: Exec, args: string[]): Promise<ExecResult> {
  return exec(systemTool("reg.exe"), args, { timeoutMs: 15_000 });
}

export async function registerAppId(exec: Exec, appId: string, displayName: string, iconPath: string): Promise<ExecResult> {
  const key = appIdKey(appId);
  const named = await reg(exec, ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", displayName, "/f"]);
  if (named.code !== 0) return named;
  return reg(exec, ["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"]);
}

export async function appIdRegistered(exec: Exec, appId: string): Promise<boolean> {
  return (await reg(exec, ["query", appIdKey(appId), "/v", "DisplayName"])).code === 0;
}

/** Removes the app id. Fine when it was never there. */
export async function removeAppId(exec: Exec, appId: string): Promise<ExecResult> {
  const result = await reg(exec, ["delete", appIdKey(appId), "/f"]);
  if (result.code === 0 || !(await appIdRegistered(exec, appId))) return { ...result, code: 0 };
  return result;
}
