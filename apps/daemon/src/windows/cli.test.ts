import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs, shortcutFile, webBuildNeeded } from "./cli.ts";
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

  it("writes a Start menu entry that opens the office", () => {
    assert.equal(
      shortcutFile("http://127.0.0.1:7420/", "C:\\AiHub\\apps\\daemon\\assets\\aihub.ico"),
      "[InternetShortcut]\r\nURL=http://127.0.0.1:7420/\r\nIconFile=C:\\AiHub\\apps\\daemon\\assets\\aihub.ico\r\nIconIndex=0\r\n",
    );
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
