import { systemTool } from "./names.ts";

/** Windows PowerShell 5.1, which every Windows has and which can reach WinRT and Win32. */
export function powershellPath(): string {
  return systemTool("WindowsPowerShell\\v1.0\\powershell.exe");
}

/** Runs a script passed whole, so nothing in it depends on command-line quoting or a script file. */
export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
