import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { format } from "node:util";

// The background daemon's log. Nobody watches its console, so everything it prints lands here. It
// stays bounded: past the limit the file becomes daemon.old.log, replacing the one before.

export const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

export class LogFile {
  private fd: number;
  private size: number;
  readonly oldPath: string;

  constructor(
    readonly path: string,
    private readonly limit = LOG_LIMIT_BYTES,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    const { dir, name, ext } = parse(path);
    this.oldPath = join(dir, `${name}.old${ext}`);
    this.fd = openSync(path, "a");
    this.size = fstatSync(this.fd).size;
  }

  /** Writes at once, so a crash right after still leaves the line in the file. */
  write(text: string) {
    const bytes = Buffer.from(text);
    if (this.size > 0 && this.size + bytes.length > this.limit) this.rotate();
    try {
      writeSync(this.fd, bytes);
      this.size += bytes.length;
    } catch {
      // A full disk or a lost file: logging must never take the daemon down.
    }
  }

  private rotate() {
    closeSync(this.fd);
    try {
      renameSync(this.path, this.oldPath);
      this.fd = openSync(this.path, "a");
    } catch {
      // The old log is open elsewhere, so start this one over rather than let it grow.
      this.fd = openSync(this.path, "w");
    }
    this.size = 0;
  }

  close() {
    closeSync(this.fd);
  }
}

/** Sends console output, anything written to stdout or stderr, and a crash's error to the log. */
export function sendOutputTo(log: LogFile) {
  const line =
    (level: string) =>
    (...args: unknown[]) =>
      log.write(`${new Date().toISOString()} ${level} ${format(...args)}\n`);
  console.log = console.info = line("info");
  console.debug = line("debug");
  console.warn = line("warn");
  console.error = line("error");
  const write = (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
    log.write(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  // Node prints an uncaught error itself, past stderr, so the monitor records it first.
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    log.write(`${new Date().toISOString()} fatal ${origin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  });
}
