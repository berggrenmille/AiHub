import { win32 } from "node:path";
import type { DaemonConfig } from "../config.ts";
import type { TaskAction } from "./task-xml.ts";

// Everything AiHub adds to Windows is named from one word, "AiHub" unless AIHUB_WINDOWS_NAME says
// otherwise, so a test install never touches the real one and the operator can find it all.

export interface WindowsNames {
  /** What the operator sees: the notification sender and the Start menu entry. */
  displayName: string;
  /** Task Scheduler folder holding both tasks. */
  taskFolder: string;
  signInTask: string;
  wakeTask: string;
  /** The AppUserModelID notifications are shown under. */
  appId: string;
}

export function windowsNames(name: string): WindowsNames {
  return {
    displayName: name,
    taskFolder: `\\${name}\\`,
    signInTask: `\\${name}\\Start at sign-in`,
    wakeTask: `\\${name}\\Wake for briefing`,
    appId: `${name}.Office`,
  };
}

/** The Start menu entry that opens the office, and starts AiHub first when it isn't running. */
export function shortcutPath(name: string, appData = process.env.APPDATA ?? ""): string {
  return win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", `${name}.lnk`);
}

/** The entry earlier installs made, which only opened the office: install replaces it. */
export function oldShortcutPath(name: string, appData = process.env.APPDATA ?? ""): string {
  return win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", `${name}.url`);
}

/** AiHub's icon, for the Start menu, notifications, and the tray. */
export function iconPath(root: string, extension: "png" | "ico"): string {
  return win32.join(root, "apps", "daemon", "assets", `aihub.${extension}`);
}

export function systemTool(file: string, systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  // Always the system's own copy: a PATH with Git's tools on it has a different whoami, for one.
  return win32.join(systemRoot, "System32", file);
}

/**
 * What both tasks run: the daemon in the background with no window, not even a flash. Node is a
 * console program, so started directly it gets a terminal window; a headless console host gives it
 * a console nobody sees. Paths are absolute, and the working directory is apps/daemon so that
 * `--import tsx` resolves.
 */
export function daemonAction(
  config: Pick<DaemonConfig, "root" | "passOn">,
  node = process.execPath,
  systemRoot?: string,
): TaskAction {
  return headless(config, ["src/index.ts", "--background", ...config.passOn], node, systemRoot);
}

/** What the Start menu entry runs, the same way: it opens the office, starting AiHub first if needed. */
export function openAction(
  config: Pick<DaemonConfig, "root" | "passOn">,
  node = process.execPath,
  systemRoot?: string,
): TaskAction {
  return headless(config, ["src/windows/open.ts", ...config.passOn], node, systemRoot);
}

function headless(config: Pick<DaemonConfig, "root">, script: string[], node: string, systemRoot?: string): TaskAction {
  return {
    command: systemTool("conhost.exe", systemRoot),
    args: ["--headless", node, "--disable-warning=ExperimentalWarning", "--import", "tsx", ...script],
    workingDirectory: win32.join(config.root, "apps", "daemon"),
  };
}
