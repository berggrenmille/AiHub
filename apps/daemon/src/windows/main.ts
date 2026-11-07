import { loadConfig } from "../config.ts";
import { parseArgs, runCommand, USAGE } from "./cli.ts";
import { exec } from "./exec.ts";
import { windowsNames } from "./names.ts";

// The entry point of `npm run windows -- <command>`.

const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (process.platform !== "win32") {
  console.error("This sets AiHub up on Windows, and this computer isn't running Windows.");
  process.exit(1);
}

try {
  // The settings given here become the installed daemon's own flags.
  const config = loadConfig(process.env, [process.argv[0]!, process.argv[1]!, ...parsed.settings]);
  const code = await runCommand(parsed.command, { config, names: windowsNames(config.windowsName), exec, say: (line) => console.log(line) });
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
