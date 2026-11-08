import type { Exec, ExecResult } from "./exec.ts";
import { powershellArgs, powershellPath } from "./powershell.ts";
import { commandLine, type TaskAction } from "./task-xml.ts";

/** Writes a Start menu shortcut that runs an action, minimized, under AiHub's icon. */
export function writeShortcut(exec: Exec, path: string, action: TaskAction, icon: string, description: string): Promise<ExecResult> {
  return exec(powershellPath(), powershellArgs(SHORTCUT_SCRIPT), {
    env: {
      ...process.env,
      AIHUB_LINK: path,
      AIHUB_LINK_TARGET: action.command,
      AIHUB_LINK_ARGS: commandLine(action.args),
      AIHUB_LINK_DIR: action.workingDirectory,
      AIHUB_LINK_ICON: icon,
      AIHUB_LINK_DESCRIPTION: description,
    },
  });
}

/** A .lnk through the Windows Script Host, which every Windows has. */
const SHORTCUT_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($env:AIHUB_LINK)
  $link.TargetPath = $env:AIHUB_LINK_TARGET
  $link.Arguments = $env:AIHUB_LINK_ARGS
  $link.WorkingDirectory = $env:AIHUB_LINK_DIR
  $link.IconLocation = $env:AIHUB_LINK_ICON + ',0'
  $link.Description = $env:AIHUB_LINK_DESCRIPTION
  $link.WindowStyle = 7
  $link.Save()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
