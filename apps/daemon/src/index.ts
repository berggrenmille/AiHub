import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, readPid } from "./config.ts";
import { Office } from "./office.ts";
import { seedDemoOffice, startDemoActivity } from "./demo.ts";
import { askHealth } from "./instance.ts";
import { LogFile, sendOutputTo } from "./log-file.ts";
import { NO_PLATFORM } from "./platform.ts";
import { CodexRuntime, pinnedCodexCommand } from "./runtime/codex-runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { demo, FakeRuntime } from "./runtime/fake-runtime.ts";
import { installToken } from "./security.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store/store.ts";
import { daemonAction, windowsNames } from "./windows/names.ts";
import { windowsPlatform } from "./windows/windows-platform.ts";

const config = loadConfig();
// Started by Windows, the daemon has no terminal anyone sees, so everything it says goes to the log.
const log = config.background ? new LogFile(config.logFile) : null;
if (log) sendOutputTo(log);

const store = new Store(join(config.dataDir, "aihub.db"));
const token = installToken(store);
const runtime =
  config.fakeRuntime
    ? Object.assign(new FakeRuntime(), { respond: demo })
    : new CodexRuntime({ command: pinnedCodexCommand(config.root), codexHome: config.codexHome });
const platform = config.osIntegration
  ? windowsPlatform({
      names: windowsNames(config.windowsName),
      port: config.port,
      action: daemonAction(config),
      notifications: config.notifications,
    })
  : NO_PLATFORM;
const office = new Office({ store, runtime, vaultDir: config.vaultDir, platform });

// The daemon only listens on loopback (DESIGN.md › Architecture).
const webRoot = join(config.root, "apps", "web", "dist");
const app = await buildServer({
  office,
  version: pkg.version,
  token,
  devOrigins: config.devOrigins,
  port: config.port,
  webRoot,
  logger: log ? { level: "info", stream: log } : true,
});

// Claim the port before the office starts, since starting closes out runs a daemon left unfinished:
// a second copy must leave the running daemon's work alone.
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  await runtime.close();
  store.close();
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  const answer = await askHealth(config.port, token);
  if (answer.kind === "aihub") {
    console.info(`AiHub is already running at http://127.0.0.1:${config.port}/`);
    process.exit(0);
  }
  console.error(
    answer.kind === "other-aihub"
      ? `Another AiHub, with a different data folder, is using port ${config.port}. Stop it, or give this one another port with AIHUB_PORT.`
      : `Port ${config.port} is in use by another program, so AiHub can't start. Give AiHub another port with AIHUB_PORT.`,
  );
  process.exit(1);
}

office.start();
if (config.fakeRuntime) {
  seedDemoOffice(office);
  startDemoActivity(office);
}
office.notebook.watch();
office.scheduler = new Scheduler(office);
void office.refreshRuntimeStatus();
office.scheduler.start();

// The pid tells `npm run windows -- uninstall` which process to stop.
const { pidFile } = config;
if (config.background) {
  writeFileSync(pidFile, String(process.pid));
  if (!existsSync(webRoot)) console.warn("The office isn't built, so the browser gets nothing. Run `npm run windows -- install` to build it.");
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  office.scheduler?.stop();
  await app.close();
  office.notebook.close();
  await runtime.close();
  await platform.close();
  store.close();
  if (config.background && readPid(pidFile) === process.pid) rmSync(pidFile, { force: true });
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
// Windows signals sign-out and shutdown to a console program as SIGHUP.
process.on("SIGHUP", () => void stop());
