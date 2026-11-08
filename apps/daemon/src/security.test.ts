import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { installToken, readInstallToken } from "./security.ts";
import { Store } from "./store/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Reading the install token", () => {
  it("reads it without migrating, so a newer checkout never changes the running daemon's database", () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-token-"));
    dirs.push(dir);
    const path = join(dir, "aihub.db");
    const store = new Store(path);
    const token = installToken(store);
    store.close();
    // As if the database were from an older AiHub than the code reading it.
    const older = new DatabaseSync(path);
    older.exec("PRAGMA user_version = 3");
    older.close();

    assert.equal(readInstallToken(path), token);
    const after = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual({ ...(after.prepare("PRAGMA user_version").get() as object) }, { user_version: 3 });
    after.close();

    const empty = join(dir, "empty.db");
    new DatabaseSync(empty).close();
    assert.equal(readInstallToken(empty), null);
  });
});
