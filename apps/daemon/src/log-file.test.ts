import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LogFile } from "./log-file.ts";

const dir = mkdtempSync(join(tmpdir(), "aihub-log-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("the background log", () => {
  it("keeps one older file past the limit", () => {
    const log = new LogFile(join(dir, "logs", "daemon.log"), 100);
    log.write(`${"a".repeat(60)}\n`);
    log.write(`${"b".repeat(60)}\n`);
    assert.equal(readFileSync(join(dir, "logs", "daemon.log"), "utf8"), `${"b".repeat(60)}\n`);
    assert.equal(readFileSync(join(dir, "logs", "daemon.old.log"), "utf8"), `${"a".repeat(60)}\n`);
    log.write(`${"c".repeat(60)}\n`);
    assert.equal(readFileSync(join(dir, "logs", "daemon.old.log"), "utf8"), `${"b".repeat(60)}\n`);
    log.close();
  });

  it("appends to the log a restart left", () => {
    const path = join(dir, "again.log");
    const first = new LogFile(path);
    first.write("one\n");
    first.close();
    const second = new LogFile(path);
    second.write("two\n");
    second.close();
    assert.equal(readFileSync(path, "utf8"), "one\ntwo\n");
    assert.equal(existsSync(join(dir, "again.old.log")), false);
  });
});
