import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs, webBuildNeeded } from "./cli.ts";
import { openAction, shortcutPath } from "./names.ts";
import { parseWakeTimers } from "./power.ts";

describe("npm run windows", () => {
  it("takes one command and the daemon's settings", () => {
    assert.deepEqual(parseArgs(["install"]), { command: "install", settings: [] });
    assert.deepEqual(parseArgs(["status", "--port=7421", "--windows-name=AiHubTest"]), {
      command: "status",
      settings: ["--port=7421", "--windows-name=AiHubTest"],
    });
    assert.deepEqual(parseArgs(["--data-dir=C:\\temp\\x", "uninstall", "--fake-runtime"]), {
      command: "uninstall",
      settings: ["--data-dir=C:\\temp\\x", "--fake-runtime"],
    });
    assert.deepEqual(parseArgs(["--help"]), { command: "help" });
    assert.deepEqual(parseArgs(["help"]), { command: "help" });
  });

  it("says what's wrong with anything else", () => {
    assert.match((parseArgs([]) as { error: string }).error, /install, uninstall, or status/);
    assert.match((parseArgs(["start"]) as { error: string }).error, /"start" isn't a command/);
    assert.match((parseArgs(["install", "status"]) as { error: string }).error, /One command at a time/);
    assert.match((parseArgs(["install", "--force"]) as { error: string }).error, /"--force" isn't a setting/);
    assert.match((parseArgs(["install", "--port="]) as { error: string }).error, /"--port=" isn't a setting/);
    assert.match((parseArgs(["install", "--port", "7421"]) as { error: string }).error, /One command at a time|isn't a setting/);
  });

  it("has a Start menu entry that opens the office, starting AiHub with its settings, with no window", () => {
    const action = openAction({ root: "C:\\My Projects\\AiHub", passOn: ["--port=7421"] }, "C:\\Program Files\\nodejs\\node.exe", "C:\\WINDOWS");
    assert.equal(action.command, "C:\\WINDOWS\\System32\\conhost.exe");
    assert.deepEqual(action.args, [
      "--headless",
      "C:\\Program Files\\nodejs\\node.exe",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "src/windows/open.ts",
      "--port=7421",
    ]);
    assert.equal(action.workingDirectory, "C:\\My Projects\\AiHub\\apps\\daemon");
    assert.equal(shortcutPath("AiHub", "C:\\Users\\op\\AppData\\Roaming"), "C:\\Users\\op\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\AiHub.lnk");
  });

  it("builds the office when it's missing or older than its sources", () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-web-"));
    try {
      const file = (path: string, at: number) => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), "x");
        utimesSync(join(root, path), at, at);
      };
      file("apps/web/src/App.tsx", 1_000);
      file("packages/shared/src/index.ts", 1_000);
      assert.equal(webBuildNeeded(root), true);
      file("apps/web/dist/index.html", 2_000);
      utimesSync(join(root, "apps/web/src"), 1_000, 1_000);
      utimesSync(join(root, "packages/shared/src"), 1_000, 1_000);
      assert.equal(webBuildNeeded(root), false);
      file("packages/shared/src/index.ts", 3_000);
      assert.equal(webBuildNeeded(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("wake timers in the power plan", () => {
  it("reads the AC and battery values whatever the language", () => {
    const english = `Power Setting GUID: bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d  (Allow wake timers)
      GUID Alias: RTCWAKE
      Possible Setting Index: 000
      Possible Setting Friendly Name: Disable
      Possible Setting Index: 001
      Possible Setting Friendly Name: Enable
    Current AC Power Setting Index: 0x00000001
    Current DC Power Setting Index: 0x00000000`;
    assert.deepEqual(parseWakeTimers(english), { ac: "allowed", dc: "off" });
    const swedish = `Aktuellt indexvärde för växelström: 0x00000002\nAktuellt indexvärde för likström: 0x00000001`;
    assert.deepEqual(parseWakeTimers(swedish), { ac: "important only", dc: "allowed" });
    assert.equal(parseWakeTimers("Access denied"), null);
  });
});
