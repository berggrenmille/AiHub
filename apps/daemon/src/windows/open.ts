import { spawn } from "node:child_process";
import { loadConfig } from "../config.ts";
import type { Answer } from "../instance.ts";
import { health, waitForOffice } from "./cli.ts";
import { exec, failure } from "./exec.ts";
import { systemTool, windowsNames } from "./names.ts";
import { powershellArgs, powershellPath } from "./powershell.ts";
import { runTask } from "./tasks.ts";

// What the Start menu entry runs, with no window: it opens the office in the browser, and first
// starts AiHub through its sign-in task when it isn't running, such as after Quit in the tray menu.
// It has no terminal to say what went wrong in, so a problem shows in a message box.

const MESSAGE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show($env:AIHUB_MESSAGE, $env:AIHUB_TITLE, 'OK', 'Warning')
`;

const config = loadConfig();
const names = windowsNames(config.windowsName);
const url = `http://127.0.0.1:${config.port}/`;

let answer: Answer = await health(config);
let problem: string | null = null;
if (answer.kind === "none") {
  const run = await runTask(exec, names.signInTask);
  if (run.code === 0) answer = await waitForOffice(config, 60_000);
  else problem = `AiHub couldn't start: ${failure(run)}. Install it again with npm run windows -- install.`;
}

if (answer.kind === "aihub") {
  spawn(systemTool("rundll32.exe"), ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
} else {
  problem ??=
    answer.kind === "none"
      ? `AiHub didn't start within a minute. Its log may say why: ${config.logFile}`
      : answer.kind === "other-aihub"
        ? `Another AiHub, with a different data folder, is using port ${config.port}.`
        : `Port ${config.port} is in use by another program, so AiHub can't start there.`;
  await exec(powershellPath(), powershellArgs(MESSAGE_SCRIPT), { env: { ...process.env, AIHUB_TITLE: names.displayName, AIHUB_MESSAGE: problem } });
}
process.exit(answer.kind === "aihub" ? 0 : 1);
