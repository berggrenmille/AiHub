import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { Office } from "./office.ts";
import { seedDemoOffice, startDemoActivity } from "./demo.ts";
import { CodexRuntime, pinnedCodexCommand } from "./runtime/codex-runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { demo, FakeRuntime } from "./runtime/fake-runtime.ts";
import { installToken } from "./security.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store/store.ts";

const config = loadConfig();
const store = new Store(join(config.dataDir, "aihub.db"));
const runtime =
  config.fakeRuntime
    ? Object.assign(new FakeRuntime(), { respond: demo })
    : new CodexRuntime({ command: pinnedCodexCommand(config.root), codexHome: config.codexHome });
const office = new Office({ store, runtime, vaultDir: config.vaultDir });
office.start();
if (config.fakeRuntime) {
  seedDemoOffice(office);
  startDemoActivity(office);
}
office.notebook.watch();
office.scheduler = new Scheduler(office);

// The daemon only listens on loopback (DESIGN.md › Architecture).
const app = await buildServer({
  office,
  version: pkg.version,
  token: installToken(store),
  devOrigins: config.devOrigins,
  port: config.port,
  webRoot: join(config.root, "apps", "web", "dist"),
});
await app.listen({ host: config.host, port: config.port });
void office.refreshRuntimeStatus();
office.scheduler.start();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  office.scheduler?.stop();
  await app.close();
  office.notebook.close();
  await runtime.close();
  store.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
