import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { Tray, type TrayOptions } from "./tray.ts";

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  ended = false;
  written = "";
  env: NodeJS.ProcessEnv = {};
  constructor() {
    super();
    this.stdin.setEncoding("utf8").on("data", (chunk: string) => (this.written += chunk));
    this.stdin.on("finish", () => {
      this.ended = true;
      this.exit(0);
    });
  }
  exit(code: number) {
    this.exitCode = code;
    this.emit("exit", code);
  }
  kill() {
    this.exit(1);
    return true;
  }
  /** The status lines the helper was sent, parsed. */
  lines() {
    return this.written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function tray(overrides: Partial<TrayOptions> = {}) {
  const helpers: FakeHelper[] = [];
  const logs: string[] = [];
  let quits = 0;
  const spawnFn = ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const helper = new FakeHelper();
    helper.env = options.env;
    helpers.push(helper);
    return helper;
  }) as unknown as typeof spawn;
  const icon = new Tray({
    name: "AiHubTest",
    url: "http://127.0.0.1:7421/",
    icon: "C:\\AiHub\\apps\\daemon\\assets\\aihub.ico",
    notesDir: "C:\\AiHub\\data\\vault",
    onQuit: () => quits++,
    log: (message) => logs.push(message),
    spawn: spawnFn,
    restartDelayMs: 0,
    ...overrides,
  });
  return { icon, helpers, logs, quits: () => quits };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("The tray icon", () => {
  it("starts a helper with the office, icon, and notes folder, and sends it the status", async () => {
    const { icon, helpers } = tray();
    icon.show({ status: "Next briefing Monday at 07:00", needs: [], attention: false });
    icon.start();
    await tick();
    const [helper] = helpers;
    assert.equal(helper!.env.AIHUB_TRAY_NAME, "AiHubTest");
    assert.equal(helper!.env.AIHUB_TRAY_URL, "http://127.0.0.1:7421/");
    assert.equal(helper!.env.AIHUB_TRAY_ICON, "C:\\AiHub\\apps\\daemon\\assets\\aihub.ico");
    assert.equal(helper!.env.AIHUB_TRAY_NOTES, "C:\\AiHub\\data\\vault");
    assert.deepEqual(helper!.lines(), [{ status: "Next briefing Monday at 07:00", needs: [], attention: false, tip: "AiHubTest: Next briefing Monday at 07:00" }]);
  });

  it("leads the tooltip with what needs the operator, cut to what Windows allows, and sends a status once", async () => {
    const { icon, helpers } = tray();
    icon.start();
    const status = { status: "Next briefing today at 07:00", needs: ["Briefing waiting: Codex is unavailable: workspace routing discovery failed"], attention: true };
    icon.show(status);
    icon.show({ ...status, needs: [...status.needs] });
    await tick();
    const lines = helpers[0]!.lines();
    assert.equal(lines.length, 1);
    const tip = String(lines[0]!.tip);
    assert.ok(tip.length <= 63, tip);
    assert.match(tip, /^AiHubTest: Briefing waiting: Codex is unavailable.*…$/);
  });

  it("quits AiHub when the operator chooses Quit, and logs what the helper couldn't open", async () => {
    const { icon, helpers, logs, quits } = tray();
    icon.start();
    helpers[0]!.stdout.write("ready\r\nerror Couldn't open C:\\nowhere: not found\r\n");
    await tick();
    assert.equal(quits(), 0);
    assert.deepEqual(logs, ["Couldn't open C:\\nowhere: not found"]);
    helpers[0]!.stdout.write("qu");
    helpers[0]!.stdout.write("it\r\n");
    await tick();
    assert.equal(quits(), 1);
  });

  it("closes the helper's stdin to take the icon down, and starts no other", async () => {
    const { icon, helpers } = tray();
    icon.start();
    icon.close();
    await tick();
    assert.equal(helpers[0]!.ended, true);
    assert.equal(helpers.length, 1);
    icon.start();
    assert.equal(helpers.length, 1, "a closed tray stays closed");
  });

  it("starts a helper that stopped on its own again, a few times, with the status it had", async () => {
    const { icon, helpers, logs } = tray();
    icon.start();
    icon.show({ status: "Writing your briefing…", needs: [], attention: false });
    for (let n = 0; n < 4; n++) {
      helpers.at(-1)!.stderr.write("Explorer isn't running");
      await tick();
      helpers.at(-1)!.exit(1);
      await tick();
    }
    assert.equal(helpers.length, 4, "the first and three restarts");
    assert.equal(helpers[3]!.lines()[0]!.status, "Writing your briefing…");
    assert.match(logs[0]!, /^The tray icon's helper stopped \(exit code 1\): Explorer isn't running$/);
  });
});
