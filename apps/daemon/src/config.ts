import { mkdirSync } from "node:fs";
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): DaemonConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const fakeRuntime = argv.includes("--fake-runtime");
  // The fake runtime keeps its own state, so trying out the UI never mixes with real records.
  const dataDir = env.AIHUB_DATA_DIR ? resolve(env.AIHUB_DATA_DIR) : join(root, "data", ...(fakeRuntime ? ["fake"] : []));
  const codexHome = join(root, ".codex-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const port = Number(env.AIHUB_PORT ?? 7420);
  const webPort = Number(env.AIHUB_WEB_PORT ?? 5173);
  const devOrigins =
    env.NODE_ENV === "production" ? [] : [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`];

  const vaultDir = env.AIHUB_VAULT_DIR ? resolve(env.AIHUB_VAULT_DIR) : join(dataDir, "vault");

  return { root, dataDir, vaultDir, codexHome, host: "127.0.0.1", port, devOrigins, fakeRuntime };
}
