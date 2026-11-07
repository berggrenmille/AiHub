import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "./config.ts";

const dataDir = mkdtempSync(join(tmpdir(), "aihub-config-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));
const argv = (...flags: string[]) => ["node", "index.ts", ...flags];

describe("daemon settings", () => {
  it("passes on what it was given, so a daemon Windows starts keeps the same settings", () => {
    const config = loadConfig({ AIHUB_PORT: "7421", AIHUB_NOTIFICATIONS: "Off" }, argv(`--data-dir=${dataDir}`, "--windows-name=AiHubTest"));
    assert.equal(config.port, 7421);
    assert.equal(config.dataDir, dataDir);
    assert.equal(config.windowsName, "AiHubTest");
    assert.equal(config.notifications, false);
    assert.deepEqual(config.passOn, [`--data-dir=${dataDir}`, "--port=7421", "--notifications=off", "--windows-name=AiHubTest"]);
    assert.equal(config.logFile, join(dataDir, "logs", "daemon.log"));
  });

  it("lets a flag win over the environment, and passes on nothing by default", () => {
    assert.equal(loadConfig({ AIHUB_PORT: "7421", AIHUB_DATA_DIR: dataDir }, argv("--port=7422")).port, 7422);
    const plain = loadConfig({ AIHUB_DATA_DIR: dataDir }, argv());
    assert.equal(plain.port, 7420);
    assert.equal(plain.windowsName, "AiHub");
    assert.deepEqual(plain.passOn, [`--data-dir=${dataDir}`]);
  });

  it("serves only the built UI in the background", () => {
    assert.deepEqual(loadConfig({ AIHUB_DATA_DIR: dataDir }, argv("--background")).devOrigins, []);
    assert.equal(loadConfig({ AIHUB_DATA_DIR: dataDir }, argv()).devOrigins.length, 2);
  });

  it("keeps the fake runtime away from the real platform unless notifications are on", () => {
    const env = { AIHUB_DATA_DIR: dataDir };
    assert.equal(loadConfig(env, argv()).osIntegration, true);
    assert.equal(loadConfig(env, argv("--fake-runtime")).osIntegration, false);
    assert.equal(loadConfig({ ...env, AIHUB_NOTIFICATIONS: "on" }, argv("--fake-runtime")).osIntegration, true);
    assert.deepEqual(loadConfig(env, argv("--fake-runtime")).passOn, ["--fake-runtime", `--data-dir=${dataDir}`]);
  });

  it("refuses a port or name that can't work", () => {
    assert.throws(() => loadConfig({ AIHUB_DATA_DIR: dataDir, AIHUB_PORT: "seventy" }, argv()), /port must be a number/);
    assert.throws(() => loadConfig({ AIHUB_DATA_DIR: dataDir }, argv("--windows-name=Ai Hub")), /letters, digits, and dashes/);
  });
});
