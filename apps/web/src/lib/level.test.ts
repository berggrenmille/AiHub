import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { levelOf, levelStart } from "./level.ts";

describe("levels", () => {
  it("starts level L at 5 × L × (L − 1) / 2 experience", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map(levelStart),
      [0, 5, 15, 30, 50, 75, 105, 140],
    );
  });

  it("finds the level, progress and experience to the next one", () => {
    assert.deepEqual(levelOf(0), { level: 1, into: 0, span: 5, toNext: 5, progress: 0, rank: "New hire" });
    assert.equal(levelOf(4).level, 1);
    assert.equal(levelOf(5).level, 2);
    const fourteen = levelOf(14);
    assert.equal(fourteen.level, 2);
    assert.equal(fourteen.into, 9);
    assert.equal(fourteen.span, 10);
    assert.equal(fourteen.toNext, 1);
    assert.equal(fourteen.progress, 0.9);
    assert.equal(levelOf(15).level, 3);
    assert.equal(levelOf(30).level, 4);
    assert.equal(levelOf(140).level, 8);
    assert.equal(levelOf(140).rank, "Legend");
  });

  it("keeps the last rank past level 8 and treats bad input as zero", () => {
    assert.equal(levelOf(10_000).rank, "Legend");
    assert.ok(levelOf(10_000).level > 8);
    assert.equal(levelOf(-3).level, 1);
    assert.equal(levelOf(Number.NaN).level, 1);
    assert.equal(levelOf(7.9).into, 2);
  });
});
