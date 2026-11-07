import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DaemonConfig {
  /** Repository root. */
  root: string;
  /** Local state: the SQLite database and per-run working directories. Ignored by git. */
  dataDir: string;
  /** The staff's notes: a folder of markdown that opens as an Obsidian vault. */
  vaultDir: string;
  /** AiHub's own CODEX_HOME, separate from the operator's personal ~/.codex. */
  codexHome: string;
  host: string;
  port: number;
  /** Extra browser origins allowed to call the API, such as the Vite dev server. */
  devOrigins: string[];
  /** Use the fake runtime instead of Codex, for UI work without a sign-in or usage. */
  fakeRuntime: boolean;
  /** Started by Windows rather than from a terminal: logs to a file and serves only the built UI. */
  background: boolean;
  /** Where the background daemon writes its log. */
  logFile: string;
  /** The background daemon's process id, so it can be stopped. */
  pidFile: string;
  /** Notifications outside the browser. AIHUB_NOTIFICATIONS=off turns them off. */
  notifications: boolean;
  /**
   * Whether the daemon really notifies, keeps the PC awake, and wakes it. The fake runtime doesn't,
   * so UI work never pops notifications or moves the wake timer, unless AIHUB_NOTIFICATIONS=on.
   */
  osIntegration: boolean;
  /** Names AiHub's Windows tasks, notification app id, and Start menu entry. A test install uses its own. */
  windowsName: string;
  /**
   * The settings this process was given, as flags, and --fake-runtime. Task Scheduler starts the
   * daemon without this shell's environment, so the tasks pass them on to keep the same port and folders.
   */
  passOn: string[];
}

export const DEFAULT_PORT = 7420;
export const DEFAULT_WINDOWS_NAME = "AiHub";

/** Each setting can come from a `--name=value` flag, which wins, or from its environment variable. */
const SETTINGS = {
  port: "AIHUB_PORT",
  "data-dir": "AIHUB_DATA_DIR",
  "vault-dir": "AIHUB_VAULT_DIR",
  notifications: "AIHUB_NOTIFICATIONS",
  "windows-name": "AIHUB_WINDOWS_NAME",
} as const;

type Setting = keyof typeof SETTINGS;

function setting(name: Setting, env: NodeJS.ProcessEnv, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const flag = argv.findLast((arg) => arg.startsWith(prefix));
  return (flag === undefined ? env[SETTINGS[name]] : flag.slice(prefix.length)) || undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): DaemonConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const fakeRuntime = argv.includes("--fake-runtime");
  const background = argv.includes("--background");
  const passOn: string[] = fakeRuntime ? ["--fake-runtime"] : [];
  const given = (name: Setting, normalize = (value: string) => value) => {
    const value = setting(name, env, argv);
    if (value === undefined) return undefined;
    passOn.push(`--${name}=${normalize(value)}`);
    return normalize(value);
  };

  // The fake runtime keeps its own state, so trying out the UI never mixes with real records.
  const dataDir = given("data-dir", resolve) ?? join(root, "data", ...(fakeRuntime ? ["fake"] : []));
  const codexHome = join(root, ".codex-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const rawPort = given("port");
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`The port must be a number from 1 to 65535, not "${rawPort}".`);
  const webPort = Number(env.AIHUB_WEB_PORT ?? 5173);
  // In the background only the built UI talks to the daemon, so no dev server origin is allowed.
  const devOrigins =
    background || env.NODE_ENV === "production" ? [] : [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`];

  const vaultDir = given("vault-dir", resolve) ?? join(dataDir, "vault");

  const notifySetting = given("notifications", (value) => value.toLowerCase());
  const windowsName = given("windows-name") ?? DEFAULT_WINDOWS_NAME;
  // It names a task folder, a registry key, and a file, so it stays plain.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(windowsName)) {
    throw new Error(`The Windows name must be letters, digits, and dashes, not "${windowsName}".`);
  }

  return {
    root,
    dataDir,
    vaultDir,
    codexHome,
    host: "127.0.0.1",
    port,
    devOrigins,
    fakeRuntime,
    background,
    logFile: join(dataDir, "logs", "daemon.log"),
    pidFile: join(dataDir, "daemon.pid"),
    notifications: notifySetting !== "off",
    osIntegration: !fakeRuntime || notifySetting === "on",
    windowsName,
    passOn,
  };
}

/** The process id in a pid file, or null when there is none. */
export function readPid(file: string): number | null {
  try {
    return Number(readFileSync(file, "utf8").trim()) || null;
  } catch {
    return null;
  }
}
