import { randomUUID } from "node:crypto";
import type { DaemonEvent } from "@aihub/shared";

export interface SequencedEvent {
  id: number;
  event: DaemonEvent;
}

type Listener = (event: SequencedEvent) => void;

/**
 * The state stream behind the roster, feed, chat, and later the office. Each event gets a sequence
 * number, and recent events are kept so a client that reconnects can catch up from the last one it saw.
 * Event IDs carry a boot ID, so an ID from before a daemon restart is never mistaken for a current one.
 */
export class EventBus {
  readonly bootId = randomUUID().slice(0, 8);
  private lastId = 0;
  private readonly recent: SequencedEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly keep = 1000) {}

  get lastEventId(): string {
    return this.format(this.lastId);
  }

  format(id: number): string {
    return `${this.bootId}-${id}`;
  }

  publish(event: DaemonEvent) {
    const sequenced = { id: ++this.lastId, event };
    this.recent.push(sequenced);
    if (this.recent.length > this.keep) this.recent.shift();
    for (const listener of this.listeners) listener(sequenced);
  }

  /**
   * Events after the given event ID, or null when the client must reload state first: the ID is
   * from an earlier boot, malformed, or older than the events still kept.
   */
  after(eventId: string): SequencedEvent[] | null {
    const [boot, sequence] = eventId.split("-");
    const afterId = Number(sequence);
    if (boot !== this.bootId || !Number.isInteger(afterId) || afterId > this.lastId) return null;
    const oldest = this.recent[0]?.id ?? this.lastId + 1;
    if (afterId < oldest - 1) return null;
    return this.recent.filter((sequenced) => sequenced.id > afterId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
