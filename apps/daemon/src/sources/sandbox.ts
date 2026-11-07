import { Worker } from "node:worker_threads";
import type { ReaderFile, ReaderRecord } from "./reader.ts";
import type { BoxFailure, BoxJob, BoxOutcome, WorkerMessage } from "./sandbox-worker.ts";

// The reader sandbox (DESIGN.md › Connectors and capabilities): runs a reader that staff wrote, which
// may have been written by a manipulated agent, so it's untrusted code. It runs in QuickJS compiled to
// WebAssembly (see sandbox-worker.ts), where there is nothing to reach: no files, network, processes,
// timers, or host objects, only the language and the file it's given. Out comes one JSON string per
// file, which is parsed and handed through checkRecords.
//
// QuickJS lives in a worker thread, which keeps the daemon responsive while readers run and lets this
// side kill a reader stuck where QuickJS's own deadline can't reach (a few native loops never check
// it) or one that broke QuickJS itself; a fresh worker takes its place.

export interface SandboxLimits {
  /** QuickJS heap for one file, including the file's text. */
  memoryBytes: number;
  msPerFile: number;
  msTotal: number;
  /** The JSON of one file's records. */
  outputBytesPerFile: number;
}

export const SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  msPerFile: 1_000,
  msTotal: 10_000,
  outputBytesPerFile: 1024 * 1024,
};

export interface SandboxRun {
  records: Array<{ file: string; records: ReaderRecord[] }>;
  errors: Array<{ file: string; error: string }>;
}

/** The reader's code can't run at all: it doesn't parse, throws as it loads, or has no read(). */
export class ReaderCodeError extends Error {}

/** How long past its deadline the worker may take to answer before it's taken to be stuck and killed. */
const GRACE_MS = 500;
const WORKER_URL = new URL("./sandbox-worker.ts", import.meta.url);

/** Starts the sandbox's worker and loads QuickJS into it once; later calls reuse it. */
export async function loadSandbox(): Promise<void> {
  await liveWorker();
}

/**
 * Runs a reader against files, each in a fresh QuickJS runtime. Throws ReaderCodeError only if the
 * code itself can't load; a file that fails goes into `errors` with a message saying why, and the
 * other files still run. Runs one at a time; calls made meanwhile wait their turn.
 */
export async function runReader(code: string, files: ReaderFile[], limits: Partial<SandboxLimits> = {}): Promise<SandboxRun> {
  const settings = { ...SANDBOX_LIMITS, ...limits };
  for (const [name, value] of Object.entries(settings)) {
    if (!(value > 0)) throw new RangeError(`Sandbox limit ${name} must be a positive number, not ${value}.`);
  }
  const run = queue.then(() => readAll(code, files, settings));
  queue = run.catch(() => undefined);
  return run;
}

let queue: Promise<unknown> = Promise.resolve();

async function readAll(code: string, files: ReaderFile[], limits: SandboxLimits): Promise<SandboxRun> {
  await liveWorker(); // Starting the worker the first time doesn't count against the reader's time.
  const endsAt = performance.now() + limits.msTotal;
  // Each step gets the per-file limit or what's left of the total, whichever is nearer. A worker
  // replaced after a kill is started before the step's budget is taken.
  const turn = async (): Promise<Turn> => {
    const sandbox = await liveWorker();
    const left = Math.floor(endsAt - performance.now());
    return left < limits.msPerFile ? { sandbox, ms: Math.max(0, left), total: true } : { sandbox, ms: limits.msPerFile, total: false };
  };
  const job = (file: ReaderFile | null, ms: number): Omit<BoxJob, "id"> => ({
    code,
    file,
    budgetMs: ms,
    memoryBytes: limits.memoryBytes,
    outputBytes: limits.outputBytesPerFile,
  });

  const loading = await turn();
  const check = await loading.sandbox.run(job(null, loading.ms), loading.ms + GRACE_MS);
  if (!check.ok) throw new ReaderCodeError(loadMessage(check.failure, code, loading.ms, limits));

  const run: SandboxRun = { records: [], errors: [] };
  for (const file of files) {
    const step = await turn();
    if (step.ms === 0) {
      run.errors.push({ file: file.name, error: `Not read: reading all the files took longer than ${limits.msTotal} ms.` });
    } else if (file.text.length > limits.memoryBytes) {
      run.errors.push({ file: file.name, error: fileMessage({ kind: "too-big", phase: "read", detail: "" }, step, limits) });
    } else {
      const outcome = await step.sandbox.run(job(file, step.ms), step.ms + GRACE_MS);
      if (outcome.ok) run.records.push({ file: file.name, records: outcome.records });
      else run.errors.push({ file: file.name, error: fileMessage(outcome.failure, step, limits) });
    }
  }
  return run;
}

interface Turn {
  sandbox: SandboxWorker;
  ms: number;
  /** The run's total deadline is the nearer one. */
  total: boolean;
}

function loadMessage(failure: BoxFailure, code: string, ms: number, limits: SandboxLimits): string {
  switch (failure.kind) {
    case "syntax": {
      const hint = /^\s*(import|export)\b/m.test(code) ? " Readers are plain scripts, so leave out import and export." : "";
      return `The reader has a syntax error: ${failure.detail}.${hint}`;
    }
    case "no-read":
      return "The reader doesn't define read(). Write a plain script with function read(file) { … } that returns a list of { key, title, fields } records.";
    case "timeout":
      return `The reader's code took longer than ${ms} ms to load.`;
    case "memory":
      return `The reader's code ran out of memory while loading (the limit is ${formatBytes(limits.memoryBytes)}).`;
    case "stack":
      return "The reader's code nests or recurses too deeply to load (stack overflow).";
    case "crashed":
      return `The reader's code crashed the sandbox while loading: ${failure.detail}`;
    default:
      return `The reader's code threw while loading: ${failure.detail}`;
  }
}

function fileMessage(failure: BoxFailure, turn: Pick<Turn, "total">, limits: SandboxLimits): string {
  const who = failure.phase === "load" ? "The reader's code" : "read()";
  switch (failure.kind) {
    case "timeout":
      return turn.total
        ? `Stopped: reading all the files took longer than ${limits.msTotal} ms.`
        : `${who} took longer than ${limits.msPerFile} ms and was stopped.`;
    case "memory":
      return `${who} ran out of memory (the limit is ${formatBytes(limits.memoryBytes)} per file).`;
    case "stack":
      return `${who} recursed or nested too deeply (stack overflow).`;
    case "too-big":
      return `The file is too large to read in the sandbox (its memory limit is ${formatBytes(limits.memoryBytes)}).`;
    case "promise":
      return "read() returned a promise. Readers can't be async: return the list of records itself.";
    case "no-output":
      return "read() returned nothing. It must return a list of { key, title, fields } records.";
    case "unserializable":
      return `read() returned something that can't be turned into JSON: ${failure.detail}`;
    case "too-large":
      return `read() returned ${formatBytes(Number(failure.detail))} of records as JSON; the limit is ${formatBytes(limits.outputBytesPerFile)} per file.`;
    case "bad-records":
      return failure.detail;
    case "crashed":
      return `The sandbox crashed while reading this file (${failure.detail}) and was restarted.`;
    case "threw":
      return `read() threw: ${failure.detail}`;
    case "no-read":
      return "The reader's code didn't define read() when loaded for this file.";
    default:
      return `The reader's code threw while loading: ${failure.detail}`;
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number(mb.toFixed(1))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let current: SandboxWorker | null = null;

/** The running worker, started (or replaced, if the last one died or was killed) as needed. */
async function liveWorker(): Promise<SandboxWorker> {
  if (!current?.alive) current = new SandboxWorker();
  const sandbox = current;
  try {
    await sandbox.ready;
  } catch (error) {
    if (current === sandbox) current = null;
    throw error;
  }
  return sandbox;
}

class SandboxWorker {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private dead = false;
  private lastError = "";
  private nextId = 1;

  constructor() {
    // tsx's loader doesn't reach worker threads, so the .ts worker loads through Node's own type
    // stripping, on by default from Node 22.18 and switched on here for older 22s. The worker's native
    // stack is generous so QuickJS's own stack check (STACK_BYTES in the worker) trips first: at 4 MB,
    // deeply nested code overflowed the native stack inside QuickJS's parser; 8 MB was enough.
    this.worker = new Worker(WORKER_URL, {
      execArgv: process.features.typescript ? undefined : [...process.execArgv, "--experimental-strip-types"],
      resourceLimits: { stackSizeMb: 16, maxOldGenerationSizeMb: 256 },
    });
    this.worker.on("error", (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.dead = true;
    });
    this.worker.on("exit", () => {
      this.dead = true;
    });
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (message: WorkerMessage) => {
        if (!("ready" in message)) return;
        this.worker.off("message", onMessage).off("exit", onExit);
        this.worker.unref(); // An idle sandbox doesn't keep the daemon (or a test run) alive.
        resolve();
      };
      const onExit = (code: number) => {
        this.worker.off("message", onMessage);
        reject(new Error(`The reader sandbox couldn't start (exit code ${code}${this.lastError ? `: ${this.lastError}` : ""}).`));
      };
      this.worker.on("message", onMessage).on("exit", onExit);
    });
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** Runs one job; if no answer comes within waitMs, the worker is killed and the job timed out. */
  run(job: Omit<BoxJob, "id">, waitMs: number): Promise<BoxOutcome> {
    const phase = job.file === null ? "load" : "read";
    if (this.dead) return Promise.resolve({ ok: false, failure: { kind: "crashed", phase, detail: this.lastError || "the sandbox had stopped" } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const finish = (outcome: BoxOutcome) => {
        clearTimeout(timer);
        this.worker.off("message", onMessage).off("exit", onExit);
        this.worker.unref();
        resolve(outcome);
      };
      const onMessage = (message: WorkerMessage) => {
        if ("ready" in message || message.id !== id) return;
        if (message.retire) this.kill();
        finish(message.outcome);
      };
      const onExit = (code: number) => {
        finish({ ok: false, failure: { kind: "crashed", phase, detail: this.lastError || `the sandbox exited with code ${code}` } });
      };
      const timer = setTimeout(() => {
        this.kill();
        finish({ ok: false, failure: { kind: "timeout", phase, detail: "" } });
      }, waitMs);
      this.worker.on("message", onMessage).on("exit", onExit);
      this.worker.ref();
      this.worker.postMessage({ ...job, id } satisfies BoxJob);
    });
  }

  kill(): void {
    this.dead = true;
    void this.worker.terminate();
  }
}
