// What the daemon asks of the operating system when it works in the background (DESIGN.md › Windows
// lifecycle): notifications outside the browser, staying awake while a briefing is due, and waking
// the PC for the next one. The scheduler decides when; a platform only carries it out. Off Windows,
// and in tests, nothing happens.

export interface Notification {
  title: string;
  body: string;
  /** Where in the office a click leads, such as "/". */
  path?: string;
  /** A later notification with the same tag replaces this one. */
  tag?: string;
}

export interface Platform {
  /** Shows a notification outside the browser. Never throws: a notification that can't show is logged and dropped. */
  notify(notification: Notification): Promise<void>;
  /** While true, asks the system not to sleep. Calling it again with the same value does nothing. */
  stayAwake(awake: boolean): void;
  /** Sets the one wake-up for the next time the PC must be awake, replacing any earlier one; null clears it. Never throws. */
  wakeAt(at: Date | null): Promise<void>;
  close(): Promise<void>;
}

/** A platform that does nothing, for tests and systems AiHub doesn't integrate with. */
export const NO_PLATFORM: Platform = {
  notify: async () => {},
  stayAwake: () => {},
  wakeAt: async () => {},
  close: async () => {},
};

/** A platform that records what it was asked, for tests. */
export class RecordingPlatform implements Platform {
  readonly notifications: Notification[] = [];
  awake = false;
  wake: Date | null = null;

  async notify(notification: Notification) {
    this.notifications.push(notification);
  }

  stayAwake(awake: boolean) {
    this.awake = awake;
  }

  async wakeAt(at: Date | null) {
    this.wake = at;
  }

  async close() {}
}
