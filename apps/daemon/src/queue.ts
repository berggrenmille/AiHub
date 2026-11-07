export type Priority = "interactive" | "background";

interface Job {
  priority: Priority;
  work: () => Promise<void>;
}

/**
 * The run queue (DESIGN.md › Recruitment and delegation). V1 has one execution slot, and
 * interactive chat goes first whenever a slot becomes free.
 */
export class RunQueue {
  private readonly waiting: Job[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly slots = 1,
    private readonly onError: (error: unknown) => void = (error) => console.error(error),
  ) {}

  get size(): number {
    return this.waiting.length + this.running;
  }

  enqueue(priority: Priority, work: () => Promise<void>) {
    this.waiting.push({ priority, work });
    this.next();
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private next() {
    while (this.running < this.slots && this.waiting.length > 0) {
      const index = this.waiting.findIndex((job) => job.priority === "interactive");
      const [job] = this.waiting.splice(index === -1 ? 0 : index, 1);
      this.running++;
      job!
        .work()
        .catch(this.onError)
        .finally(() => {
          this.running--;
          this.next();
          if (this.size === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
        });
    }
  }
}
