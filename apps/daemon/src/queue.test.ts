import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunQueue } from "./queue.ts";

describe("RunQueue", () => {
  it("runs one job at a time and lets interactive work jump the queue", async () => {
    const queue = new RunQueue(1);
    const order: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));

    queue.enqueue("background", async () => {
      order.push("briefing starts");
      await blocker;
      order.push("briefing ends");
    });
    queue.enqueue("background", async () => void order.push("report"));
    queue.enqueue("interactive", async () => void order.push("chat"));
    assert.equal(queue.size, 3);

    release();
    await queue.idle();

    assert.deepEqual(order, ["briefing starts", "briefing ends", "chat", "report"]);
  });

  it("keeps going after a job fails", async () => {
    const errors: unknown[] = [];
    const queue = new RunQueue(1, (error) => errors.push(error));
    let ran = false;

    queue.enqueue("background", async () => {
      throw new Error("boom");
    });
    queue.enqueue("background", async () => void (ran = true));
    await queue.idle();

    assert.equal(ran, true);
    assert.equal(errors.length, 1);
  });
});
