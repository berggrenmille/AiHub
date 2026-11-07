import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DaemonConfig {
  /** Repository root. */
  root: string;
  /** Local state: the SQLite database and per-run working directories. Ignored by git. */
  dataDir: string;
  /** AiHub's own CODEX_HOME, separate from the operator's personal ~/.codex. */
  codexHome: string;
  host: string;
  port: number;
  /** Extra browser origins allowed to call the API, such as the Vite dev server. */
  devOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const dataDir = env.AIHUB_DATA_DIR ? resolve(env.AIHUB_DATA_DIR) : join(root, "data");
  const codexHome = join(root, ".codex-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const port = Number(env.AIHUB_PORT ?? 7420);
  const webPort = Number(env.AIHUB_WEB_PORT ?? 5173);
  const devOrigins =
    env.NODE_ENV === "production" ? [] : [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`];

  return { root, dataDir, codexHome, host: "127.0.0.1", port, devOrigins };
}
