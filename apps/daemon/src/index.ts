import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { Office } from "./office.ts";
import { CodexRuntime, pinnedCodexCommand } from "./runtime/codex-runtime.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store/store.ts";

const config = loadConfig();
const store = new Store(join(config.dataDir, "aihub.db"));
const runtime = new CodexRuntime({ command: pinnedCodexCommand(config.root), codexHome: config.codexHome });
const office = new Office({ store, runtime });
office.start();

// The daemon only listens on loopback (DESIGN.md › Architecture).
const app = await buildServer({ office, version: pkg.version, port: config.port, webRoot: join(config.root, "apps", "web", "dist") });
await app.listen({ host: config.host, port: config.port });
void office.refreshRuntimeStatus();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await runtime.close();
  store.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
