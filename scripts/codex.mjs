// Runs the project's pinned Codex CLI with AiHub's own CODEX_HOME (.codex-home/), so AiHub never
// picks up your personal ~/.codex config, MCP servers, or sign-in (DESIGN.md › Authority and data boundaries).
// Usage: npm run codex -- <args>, for example `npm run codex -- login`.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = join(root, ".codex-home");
mkdirSync(codexHome, { recursive: true });

const result = spawnSync(
  process.execPath,
  [join(root, "node_modules", "@openai", "codex", "bin", "codex.js"), ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, CODEX_HOME: codexHome } },
);
process.exit(result.status ?? 1);
