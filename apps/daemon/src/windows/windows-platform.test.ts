import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { NO_PLATFORM } from "../platform.ts";
import type { Exec, ExecResult } from "./exec.ts";
import { windowsNames } from "./names.ts";
import { windowsPlatform, type WindowsPlatformOptions } from "./windows-platform.ts";

interface Call {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** The task definition schtasks was given, read while the file still exists. */
  xml?: string;
}

const NOW = new Date("2026-11-08T20:00:00Z");
const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

/** Records what the platform runs; `answer` decides each result. */
function recorder(answer: (call: Call) => ExecResult | Promise<ExecResult> = () => OK) {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    const call: Call = { command, args, env: options?.env };
    const file = args[args.indexOf("/XML") + 1];
    if (args.includes("/XML") && file) call.xml = readFileSync(file, "utf16le").replace(/^\uFEFF/, "");
    calls.push(call);
    return answer(call);
  };
  return { calls, exec };
}

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  ended = false;
  constructor() {
    super();
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
  unref() {}
}

function fakeSpawn() {
  const helpers: FakeHelper[] = [];
  const spawnFn = (() => {
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  }) as unknown as typeof spawn;
  return { helpers, spawn: spawnFn };
}

function platform(exec: Exec, overrides: Partial<WindowsPlatformOptions> = {}) {
  const logs: string[] = [];
  const result = windowsPlatform({
    names: windowsNames("AiHubTest"),
    port: 7421,
    action: { command: "C:\\WINDOWS\\System32\\conhost.exe", args: ["--headless", "node.exe", "--background"], workingDirectory: "C:\\AiHub\\apps\\daemon" },
    notifications: true,
    userId: "S-1-5-21-1",
    now: () => NOW,
    exec,
    spawn: fakeSpawn().spawn,
    os: "win32",
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { platform: result, logs };
}

describe("the Windows platform", () => {
  it("does nothing off Windows", () => {
    assert.equal(windowsPlatform({ ...({} as WindowsPlatformOptions), os: "linux" }), NO_PLATFORM);
  });

  it("shows toasts one at a time, under AiHub's app id, with the toast in the environment", async () => {
    let running = 0;
    let most = 0;
    const { calls, exec } = recorder(async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return OK;
    });
    const { platform: windows } = platform(exec);
    await Promise.all([
      windows.notify({ title: "Briefing ready", body: "2 new", path: "/", tag: "briefing" }),
      windows.notify({ title: "Health check", body: "Codex is signed out" }),
    ]);
    assert.equal(most, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(calls[0]!.args.includes("-EncodedCommand"));
    assert.equal(calls[0]!.env?.AIHUB_TOAST_APP, "AiHubTest.Office");
    assert.equal(calls[0]!.env?.AIHUB_TOAST_TAG, "briefing");
    assert.match(calls[0]!.env?.AIHUB_TOAST_XML ?? "", /launch="http:\/\/127\.0\.0\.1:7421\/"/);
    assert.equal(calls[1]!.env?.AIHUB_TOAST_TAG, "");
  });

  it("logs a toast that fails instead of throwing, and shows none when notifications are off", async () => {
    const { exec } = recorder(() => ({ code: 1, stdout: "", stderr: "Element not found.\r\n" }));
    const { platform: windows, logs } = platform(exec);
    await windows.notify({ title: "Briefing ready", body: "" });
    assert.deepEqual(logs, ['Couldn\'t show the notification "Briefing ready": Element not found.']);

    const quiet = recorder();
    await platform(quiet.exec, { notifications: false }).platform.notify({ title: "Hidden", body: "" });
    assert.equal(quiet.calls.length, 0);
  });

  it("keeps one wake task, at the instant asked for", async () => {
    const { calls, exec } = recorder();
    const { platform: windows } = platform(exec);
    const at = new Date("2026-11-09T04:55:00.400Z");
    await Promise.all([windows.wakeAt(at), windows.wakeAt(new Date(at.getTime() + 300))]);
    assert.equal(calls.length, 1, "the same second twice registers once");
    const call = calls[0]!;
    assert.match(call.command, /schtasks\.exe$/);
    assert.deepEqual(call.args.slice(0, 2), ["/Create", "/TN"]);
    assert.equal(call.args[2], "\\AiHubTest\\Wake for briefing");
    assert.ok(call.args.includes("/F"));
    assert.match(call.xml ?? "", /<WakeToRun>true<\/WakeToRun>/);
    assert.equal(new Date(/<StartBoundary>(.*)<\/StartBoundary>/.exec(call.xml ?? "")![1]!).getTime(), Date.parse("2026-11-09T04:55:00Z"));
    assert.match(call.xml ?? "", /<UserId>S-1-5-21-1<\/UserId>/);

    await windows.wakeAt(null);
    assert.deepEqual(calls[1]!.args, ["/Delete", "/TN", "\\AiHubTest\\Wake for briefing", "/F"]);
    await windows.wakeAt(null);
    assert.equal(calls.length, 2);
  });

  it("keeps no wake task when it isn't the installed daemon", async () => {
    const { calls, exec } = recorder();
    const { platform: windows } = platform(exec, { wake: false });
    await windows.wakeAt(new Date("2026-11-09T04:55:00Z"));
    await windows.wakeAt(null);
    assert.equal(calls.length, 0);
  });

  it("clears the wake task for a time that has passed, and tries again after a failure", async () => {
    let fail = true;
    const { calls, exec } = recorder((call) => (call.args[0] === "/Create" && fail ? { code: 1, stdout: "", stderr: "ERROR: Access is denied." } : OK));
    const { platform: windows, logs } = platform(exec);
    await windows.wakeAt(new Date(NOW.getTime() - 60_000));
    assert.equal(calls[0]!.args[0], "/Delete");

    const at = new Date("2026-11-09T04:55:00Z");
    await windows.wakeAt(at);
    assert.match(logs.at(-1) ?? "", /^Couldn't set the PC to wake at .*: ERROR: Access is denied\.$/);
    fail = false;
    await windows.wakeAt(at);
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["/Delete", "/Create", "/Create"],
    );
  });

  it("looks up the operator's SID when it isn't given", async () => {
    const { calls, exec } = recorder((call) =>
      call.command.endsWith("whoami.exe") ? { code: 0, stdout: '"desktop\\operator","S-1-5-21-9-8-7-1001"\r\n', stderr: "" } : OK,
    );
    const { platform: windows } = platform(exec, { userId: undefined });
    await windows.wakeAt(new Date("2026-11-09T04:55:00Z"));
    await windows.wakeAt(new Date("2026-11-10T04:55:00Z"));
    assert.equal(calls.filter((call) => call.command.endsWith("whoami.exe")).length, 1);
    assert.match(calls.at(-1)!.xml ?? "", /<UserId>S-1-5-21-9-8-7-1001<\/UserId>/);
  });

  it("holds one stay-awake helper until released", async () => {
    const { helpers, spawn } = fakeSpawn();
    const { platform: windows, logs } = platform(recorder().exec, { spawn });
    windows.stayAwake(true);
    windows.stayAwake(true);
    assert.equal(helpers.length, 1);
    helpers[0]!.stdout.write("awake\r\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(logs.includes("Keeping the PC awake until the briefing is done"));

    windows.stayAwake(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(helpers[0]!.ended, true, "releasing closes the helper's stdin");
    windows.stayAwake(false);
    windows.stayAwake(true);
    assert.equal(helpers.length, 2);
    await windows.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(helpers[1]!.ended, true, "closing releases it too");
  });

  it("starts a new helper when the old one stopped on its own", async () => {
    const { helpers, spawn } = fakeSpawn();
    const { platform: windows, logs } = platform(recorder().exec, { spawn });
    windows.stayAwake(true);
    helpers[0]!.stderr.write("SetThreadExecutionState refused the request");
    await new Promise((resolve) => setImmediate(resolve));
    helpers[0]!.exit(1);
    assert.match(logs.at(-1) ?? "", /stopped \(exit code 1\): SetThreadExecutionState refused the request/);
    windows.stayAwake(true);
    assert.equal(helpers.length, 2);
  });
});
