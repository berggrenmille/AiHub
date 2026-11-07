import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { NO_PLATFORM, type Notification, type Platform } from "../platform.ts";
import { AWAKE_SCRIPT } from "./awake.ts";
import { exec as nodeExec, failure, type Exec } from "./exec.ts";
import type { WindowsNames } from "./names.ts";
import { powershellArgs, powershellPath } from "./powershell.ts";
import { currentUserSid, deleteTask, registerTask } from "./tasks.ts";
import { wakeTaskXml, type TaskAction } from "./task-xml.ts";
import { TOAST_SCRIPT, toastTag, toastXml } from "./toast.ts";

// The platform on Windows (DESIGN.md › Windows lifecycle): toasts, a helper process that keeps the
// PC awake, and one Task Scheduler task that wakes it. Everything here runs Windows' own tools and
// logs what goes wrong; nothing throws into the scheduler.

export interface WindowsPlatformOptions {
  names: WindowsNames;
  /** The daemon's port: a click on a notification opens the office there. */
  port: number;
  /** What the wake task runs: the same command as the sign-in task, so it starts the daemon if needed. */
  action: TaskAction;
  /** False when AIHUB_NOTIFICATIONS=off. Staying awake and waking still work. */
  notifications: boolean;
  log?: (message: string) => void;
  /** The operator's SID, which the wake task runs as. Looked up when left out. */
  userId?: string;
  now?: () => Date;
  /** Tests replace how tools run, and the platform's OS. */
  exec?: Exec;
  spawn?: typeof nodeSpawn;
  os?: NodeJS.Platform;
}

const TOAST_TIMEOUT_MS = 30_000;

export function windowsPlatform(options: WindowsPlatformOptions): Platform {
  if ((options.os ?? process.platform) !== "win32") return NO_PLATFORM;
  return new WindowsPlatform(options);
}

class WindowsPlatform implements Platform {
  private readonly exec: Exec;
  private readonly spawn: typeof nodeSpawn;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly origin: string;
  private closed = false;
  /** Toasts show one at a time, in order. */
  private toasts: Promise<void> = Promise.resolve();
  private helper: ChildProcess | null = null;
  /** The wake time asked for last, and the one the task has: undefined until known. */
  private wantedWake: number | null = null;
  private appliedWake: number | null | undefined = undefined;
  private waking: Promise<void> = Promise.resolve();
  private userId: string | undefined;

  constructor(private readonly options: WindowsPlatformOptions) {
    this.exec = options.exec ?? nodeExec;
    this.spawn = options.spawn ?? nodeSpawn;
    this.log = options.log ?? ((message) => console.warn(`[windows] ${message}`));
    this.now = options.now ?? (() => new Date());
    this.origin = `http://127.0.0.1:${options.port}`;
    this.userId = options.userId;
  }

  notify(notification: Notification): Promise<void> {
    if (this.closed || !this.options.notifications) return Promise.resolve();
    this.toasts = this.toasts.then(() => this.showToast(notification));
    return this.toasts;
  }

  private async showToast(notification: Notification) {
    try {
      const result = await this.exec(powershellPath(), powershellArgs(TOAST_SCRIPT), {
        env: {
          ...process.env,
          AIHUB_TOAST_XML: toastXml(notification, this.origin),
          AIHUB_TOAST_APP: this.options.names.appId,
          AIHUB_TOAST_TAG: notification.tag ? toastTag(notification.tag) : "",
        },
        timeoutMs: TOAST_TIMEOUT_MS,
      });
      if (result.code !== 0) this.log(`Couldn't show the notification "${notification.title}": ${failure(result)}`);
    } catch (error) {
      this.log(`Couldn't show the notification "${notification.title}": ${String(error)}`);
    }
  }

  stayAwake(awake: boolean) {
    if (!awake) return this.release();
    if (this.closed || this.helper) return;
    let helper: ChildProcess;
    try {
      helper = this.spawn(powershellPath(), powershellArgs(AWAKE_SCRIPT), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      this.log(`Couldn't ask Windows to stay awake: ${String(error)}`);
      return;
    }
    this.helper = helper;
    let said = "";
    helper.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (!said && chunk.startsWith("awake") && this.helper === helper) this.log("Keeping the PC awake until the briefing is done");
      said += chunk;
    });
    helper.stderr?.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
    // A helper that already exited can't take its stdin; that shows in its exit instead.
    helper.stdin?.on("error", () => {});
    helper.on("error", (error) => {
      if (this.helper === helper) this.helper = null;
      this.log(`Couldn't ask Windows to stay awake: ${error.message}`);
    });
    helper.on("exit", (code) => {
      if (this.helper !== helper) return;
      // Still wanted: the next stayAwake(true) starts a new one.
      this.helper = null;
      this.log(`The helper keeping the PC awake stopped (exit code ${code}): ${said.replace(/^awake\s*/, "").trim() || "no reason given"}`);
    });
    // The daemon may exit without releasing; its end closes the helper's stdin anyway.
    helper.unref();
    for (const stream of [helper.stdin, helper.stdout, helper.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
  }

  private release() {
    const helper = this.helper;
    if (!helper) return;
    this.helper = null;
    helper.stdin?.end();
    this.log("The PC can sleep again");
    // Closing stdin ends the helper at once; this is for one that hangs.
    setTimeout(() => {
      if (helper.exitCode === null) helper.kill();
    }, 5_000).unref();
  }

  wakeAt(at: Date | null): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A time that has passed would never fire, so it clears the task instead.
    this.wantedWake = at && at.getTime() > this.now().getTime() ? Math.floor(at.getTime() / 1000) * 1000 : null;
    // Calls queue up, and each applies the latest wish, so a burst of calls registers once.
    this.waking = this.waking.then(() => this.applyWake());
    return this.waking;
  }

  private async applyWake() {
    const wanted = this.wantedWake;
    if (wanted === this.appliedWake) return;
    const task = this.options.names.wakeTask;
    try {
      if (wanted === null) {
        const result = await deleteTask(this.exec, task);
        if (result.code !== 0) throw new Error(failure(result));
      } else {
        const userId = await this.operator();
        const xml = wakeTaskXml(
          {
            userId,
            description: "Wakes this PC shortly before an AiHub briefing and starts AiHub if it isn't running. AiHub keeps this task up to date.",
            action: this.options.action,
          },
          new Date(wanted),
        );
        const result = await registerTask(this.exec, task, xml);
        if (result.code !== 0) throw new Error(failure(result));
      }
      this.appliedWake = wanted;
    } catch (error) {
      // Unknown now: the next call tries again.
      this.appliedWake = undefined;
      const what = wanted === null ? "remove the wake-up task" : `set the PC to wake at ${new Date(wanted).toLocaleString()}`;
      this.log(`Couldn't ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async operator(): Promise<string> {
    this.userId ??= await currentUserSid(this.exec);
    return this.userId;
  }

  async close() {
    this.release();
    this.closed = true;
    await Promise.all([this.toasts, this.waking]);
  }
}
