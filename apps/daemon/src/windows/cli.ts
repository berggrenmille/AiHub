import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPid, type DaemonConfig } from "../config.ts";
import { askHealth, type Answer } from "../instance.ts";
import { existingInstallToken } from "../security.ts";
import { Store } from "../store/store.ts";
import { appIdRegistered, registerAppId, removeAppId } from "./app-id.ts";
import { failure, type Exec } from "./exec.ts";
import { daemonAction, shortcutPath, systemTool, type WindowsNames } from "./names.ts";
import { wakeTimers, type WakeTimers } from "./power.ts";
import { powershellArgs, powershellPath } from "./powershell.ts";
import { currentUserSid, deleteTask, queryTask, registerTask, runTask, taskElement } from "./tasks.ts";
import { signInTaskXml } from "./task-xml.ts";

// `npm run windows -- install | uninstall | status` (DESIGN.md › Windows lifecycle): the daemon
// starts at sign-in with no window, a Start menu entry opens the office, and notifications show as
// AiHub. Everything is added for the current user only, so none of it needs elevation.

export const USAGE = `Usage: npm run windows -- <command> [settings]

  install     Start AiHub now and whenever you sign in, with a Start menu entry and notifications
  uninstall   Stop AiHub and remove everything install added. Your office's data stays.
  status      Say what's installed, whether AiHub answers, and when it next wakes the PC

Settings, which the installed AiHub keeps (each also works as an AIHUB_* environment variable):
  --port=7420  --data-dir=PATH  --vault-dir=PATH  --notifications=off  --windows-name=AiHub  --fake-runtime`;

const COMMANDS = ["install", "uninstall", "status"] as const;
export type Command = (typeof COMMANDS)[number];
const SETTINGS = ["--port=", "--data-dir=", "--vault-dir=", "--notifications=", "--windows-name="];

export type Parsed = { command: Command; settings: string[] } | { command: "help" } | { error: string };

/** Reads the command and settings; the settings are the daemon's own flags. */
export function parseArgs(args: string[]): Parsed {
  const words = args.filter((arg) => !arg.startsWith("-"));
  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.includes("--help") || flags.includes("-h") || words[0] === "help") return { command: "help" };
  if (!words.length) return { error: "Say what to do: install, uninstall, or status." };
  if (words.length > 1) return { error: `One command at a time, not "${words.join(" ")}".` };
  const command = COMMANDS.find((name) => name === words[0]);
  if (!command) return { error: `"${words[0]}" isn't a command. Use install, uninstall, or status.` };
  const unknown = flags.find(
    (flag) => flag !== "--fake-runtime" && !SETTINGS.some((prefix) => flag.startsWith(prefix) && flag.length > prefix.length),
  );
  if (unknown) return { error: `"${unknown}" isn't a setting. The settings are listed under --help.` };
  return { command, settings: flags };
}

export interface Context {
  config: DaemonConfig;
  names: WindowsNames;
  exec: Exec;
  say: (line: string) => void;
}

/** Runs one command and returns the exit code. */
export async function runCommand(command: Command, context: Context): Promise<number> {
  if (command === "install") return install(context);
  if (command === "uninstall") return uninstall(context);
  return status(context);
}

function officeUrl(config: DaemonConfig): string {
  return `http://127.0.0.1:${config.port}/`;
}

function iconPath(config: DaemonConfig, extension: "png" | "ico"): string {
  return join(config.root, "apps", "daemon", "assets", `aihub.${extension}`);
}

/** An internet shortcut: the Start menu lists it like an app, and it opens the office in the browser. */
export function shortcutFile(url: string, icon: string): string {
  return ["[InternetShortcut]", `URL=${url}`, `IconFile=${icon}`, "IconIndex=0", ""].join("\r\n");
}

async function install(context: Context): Promise<number> {
  const { config, names, exec, say } = context;
  if (webBuildNeeded(config.root)) {
    say("Building the office…");
    if (!(await buildWeb(config.root))) {
      say("The office didn't build. Fix what the build says above, then run install again.");
      return 1;
    }
  }

  const xml = signInTaskXml({
    userId: await currentUserSid(exec),
    description: "Starts AiHub in the background when you sign in to Windows.",
    action: daemonAction(config),
  });
  const task = await registerTask(exec, names.signInTask, xml);
  if (task.code !== 0) {
    say(`Couldn't add the sign-in task: ${failure(task)}`);
    return 1;
  }
  say(`Added the task ${names.signInTask}, which starts AiHub when you sign in.`);

  const appId = await registerAppId(exec, names.appId, names.displayName, iconPath(config, "png"));
  say(
    appId.code === 0
      ? `Notifications show as ${names.displayName}.`
      : `Couldn't register notifications (${failure(appId)}), so they show without AiHub's name and icon.`,
  );

  writeFileSync(shortcutPath(names.displayName), shortcutFile(officeUrl(config), iconPath(config, "ico")));
  say(`Added ${names.displayName} to the Start menu.`);

  // A running daemon keeps the code and settings it started with, so start it over.
  if (await stopDaemon(context)) say("Stopped the AiHub that was running, to start the new one.");
  const run = await runTask(exec, names.signInTask);
  if (run.code !== 0) {
    say(`Couldn't start AiHub: ${failure(run)}`);
    return 1;
  }
  const answer = await waitForOffice(config, 60_000);
  if (answer.kind === "other" || answer.kind === "other-aihub") {
    say(`AiHub can't start: ${describeAnswer(answer, config, null)}. Give it another port with --port.`);
    return 1;
  }
  if (answer.kind !== "aihub") {
    say(`AiHub didn't answer within a minute. Its log may say why: ${config.logFile}`);
    return 1;
  }
  const pid = await backgroundDaemon(context);
  say(
    pid
      ? `AiHub is running at ${officeUrl(config)}, in the background. Its log is ${config.logFile}`
      : `AiHub answers at ${officeUrl(config)}, but not from the background: is it running in a terminal? The background one starts when that stops and you sign in again.`,
  );
  return 0;
}

async function uninstall(context: Context): Promise<number> {
  const { config, names, exec, say } = context;
  let removed = 0;
  // First, so the daemon can't put the wake task back while it's being removed.
  if (await stopDaemon(context)) {
    say("Stopped AiHub.");
    removed++;
  }
  for (const task of [names.signInTask, names.wakeTask]) {
    if ((await queryTask(exec, task)) === null) continue;
    const result = await deleteTask(exec, task);
    say(result.code === 0 ? `Removed the task ${task}.` : `Couldn't remove the task ${task}: ${failure(result)}`);
    if (result.code !== 0) return 1;
    removed++;
  }
  await exec(powershellPath(), powershellArgs(REMOVE_FOLDER_SCRIPT), { env: { ...process.env, AIHUB_TASK_FOLDER: names.displayName } });

  const shortcut = shortcutPath(names.displayName);
  if (existsSync(shortcut)) {
    rmSync(shortcut, { force: true });
    say("Removed the Start menu entry.");
    removed++;
  }

  if (await appIdRegistered(exec, names.appId)) {
    const result = await removeAppId(exec, names.appId);
    say(result.code === 0 ? "Removed AiHub's notification registration." : `Couldn't remove the notification registration: ${failure(result)}`);
    removed++;
  }
  // AiHub's notifications would open an office that's gone, and Windows keeps settings for the sender.
  await exec(powershellPath(), powershellArgs(FORGET_NOTIFICATIONS_SCRIPT), { env: { ...process.env, AIHUB_APP_ID: names.appId } });

  say(removed ? `AiHub is uninstalled. Your office's data stays in ${config.dataDir}` : "AiHub wasn't installed.");
  return 0;
}

async function status(context: Context): Promise<number> {
  const { config, names, exec, say } = context;
  const [signIn, wake, answer, pid, timers, appId] = await Promise.all([
    queryTask(exec, names.signInTask),
    queryTask(exec, names.wakeTask),
    health(config),
    backgroundDaemon(context),
    wakeTimers(exec),
    appIdRegistered(exec, names.appId),
  ]);
  const row = (label: string, value: string) => say(`  ${label.padEnd(20)}${value}`);
  say(`AiHub on this PC`);
  row("Starts at sign-in", signIn ? `yes, by the task ${names.signInTask}` : "no. npm run windows -- install sets that up");
  row("Office", describeAnswer(answer, config, pid));
  row("Next wake-up", describeWake(wake));
  row("Wake timers", describeTimers(timers));
  const off = signIn ? /--notifications=off/i.test(taskElement(signIn, "Arguments") ?? "") : !config.notifications;
  row(
    "Notifications",
    off ? "off" : appId ? `on, shown as ${names.displayName}` : signIn ? "on, but without AiHub's name and icon" : "not set up",
  );
  row("Start menu", existsSync(shortcutPath(names.displayName)) ? names.displayName : "no entry");
  row("Log", config.logFile);
  return 0;
}

function describeAnswer(answer: Answer, config: DaemonConfig, pid: number | null): string {
  if (answer.kind === "none") return `not running (nothing answers at ${officeUrl(config)})`;
  if (answer.kind === "other-aihub") return `port ${config.port} has an AiHub with a different data folder`;
  if (answer.kind === "other") return `port ${config.port} has something that isn't AiHub (${answer.detail})`;
  const since = answer.startedAt ? `, up since ${formatTime(new Date(answer.startedAt))}` : "";
  return `answering at ${officeUrl(config)}${pid ? ", in the background" : ", from a terminal"}${since}`;
}

function describeWake(xml: string | null): string {
  const boundary = xml && taskElement(xml, "StartBoundary");
  if (!boundary) return "none set";
  const at = new Date(boundary);
  const wakes = taskElement(xml, "WakeToRun") === "true" ? "and wakes the PC" : "but doesn't wake the PC";
  return at.getTime() > Date.now() ? `${formatTime(at)}, ${wakes}` : `none: the last one, ${formatTime(at)}, has passed`;
}

function describeTimers(timers: { ac: WakeTimers; dc: WakeTimers } | null): string {
  if (!timers) return "unknown: powercfg didn't say";
  const text = `${timers.ac} on AC power, ${timers.dc} on battery`;
  return timers.ac === "allowed"
    ? text
    : `${text}. Windows won't wake the PC for briefings until "Allow wake timers" is on in the power plan's sleep settings`;
}

function formatTime(at: Date): string {
  return at.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The daemon at this data folder's answer, with its token when there is one. */
async function health(config: DaemonConfig): Promise<Answer> {
  const db = join(config.dataDir, "aihub.db");
  let token: string | null = null;
  if (existsSync(db)) {
    const store = new Store(db);
    try {
      token = existingInstallToken(store);
    } finally {
      store.close();
    }
  }
  return askHealth(config.port, token);
}

/** Waits until this office's daemon answers, or something else turns out to hold its port. */
async function waitForOffice(config: DaemonConfig, timeoutMs: number): Promise<Answer> {
  const deadline = Date.now() + timeoutMs;
  let answer = await health(config);
  while (answer.kind === "none" && Date.now() < deadline) {
    await sleep(500);
    answer = await health(config);
  }
  return answer;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The background daemon's pid, from the file it writes. Windows reuses process ids, so the process
 * must also be a daemon started with --background: a stale file never gets another program stopped.
 */
async function backgroundDaemon({ config, exec }: Context): Promise<number | null> {
  const pid = readPid(config.pidFile);
  if (!pid || !isAlive(pid)) return null;
  const result = await exec(powershellPath(), powershellArgs(COMMAND_LINE_SCRIPT), { env: { ...process.env, AIHUB_PID: String(pid) } });
  return result.stdout.includes("--background") && result.stdout.includes("index.ts") ? pid : null;
}

/** Stops the background daemon and what it started. True when one was running. */
async function stopDaemon(context: Context): Promise<boolean> {
  const { config, names, exec } = context;
  const pid = await backgroundDaemon(context);
  if (pid) {
    // A hard stop: the daemon has no window to close, and SQLite and the occurrence records are
    // built to come back from one. /T takes Codex and the stay-awake helper with it.
    await exec(systemTool("taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
    for (let wait = 0; wait < 40 && isAlive(pid); wait++) await sleep(250);
  }
  // Ending the task only stops its console host, never the daemon, but it frees the task to run again.
  await exec(systemTool("schtasks.exe"), ["/End", "/TN", names.signInTask]);
  rmSync(config.pidFile, { force: true });
  return pid !== null;
}

const WEB_SOURCES = [
  ["apps", "web", "src"],
  ["apps", "web", "index.html"],
  ["apps", "web", "vite.config.ts"],
  ["apps", "web", "package.json"],
  ["apps", "web", "tsconfig.json"],
  ["packages", "shared", "src"],
];

/** True when the built office is missing or older than anything it's built from. */
export function webBuildNeeded(root: string): boolean {
  const built = join(root, "apps", "web", "dist", "index.html");
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  return WEB_SOURCES.some((parts) => newestChange(join(root, ...parts)) > builtAt);
}

function newestChange(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules") continue;
    newest = Math.max(newest, newestChange(join(path, entry)));
  }
  return newest;
}

function buildWeb(root: string): Promise<boolean> {
  // Under npm, run the same npm; Node won't start npm.cmd without a shell.
  const npm = process.env.npm_execpath;
  const args = ["run", "build", "-w", "@aihub/web"];
  const child = npm?.endsWith(".js")
    ? spawn(process.execPath, [npm, ...args], { cwd: root, stdio: "inherit" })
    : spawn("npm", args, { cwd: root, stdio: "inherit", shell: true });
  return new Promise((resolve) => {
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/** Prints a process's command line. */
const COMMAND_LINE_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
(Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$env:AIHUB_PID)).CommandLine
`;

/** Removes AiHub's Task Scheduler folder once it's empty. */
const REMOVE_FOLDER_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\\' + $env:AIHUB_TASK_FOLDER)
  if ($folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) {
    $service.GetFolder('\\').DeleteFolder($env:AIHUB_TASK_FOLDER, 0)
  }
} catch {}
`;

/** Clears the app's notifications from the notification center, and Windows' settings for it. */
const FORGET_NOTIFICATIONS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($env:AIHUB_APP_ID)
} catch {}
# Clearing the history makes Windows write the sender's settings once more, a moment later.
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\' + $env:AIHUB_APP_ID
for ($try = 0; $try -lt 5; $try++) {
  Remove-Item -LiteralPath $key -Recurse -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
  if (-not (Test-Path -LiteralPath $key)) { break }
}
`;
