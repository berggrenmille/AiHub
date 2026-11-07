import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten-core";
import { parentPort } from "node:worker_threads";
import { checkRecords, type ReaderFile, type ReaderRecord } from "./reader.ts";

// The reader sandbox's worker thread (sandbox.ts starts it and talks to it). Everything in this file is
// trusted host code. tsx doesn't reach worker threads, so this file and what it imports load through
// Node's own type stripping: keep to erasable TypeScript here (no parameter properties or enums). The reader's code runs only inside QuickJS, a JavaScript engine compiled to
// WebAssembly: it has no require, process, fetch, timers, or file access, because none of them exist
// in there, and nothing of the host is handed in. What comes out is one JSON string per file.
//
// Each job gets a fresh QuickJS runtime and context, disposed afterwards, so nothing a reader leaves
// behind reaches the next file. Deadlines are enforced by QuickJS's interrupt handler; a few native
// loops never check it, which is why this runs in a worker that sandbox.ts kills when it overstays.

/** QuickJS's own stack limit. The WASM build has a 5 MB stack; this stays far inside it. */
const STACK_BYTES = 256 * 1024;
const FILENAME = "reader.js";

export interface BoxJob {
  id: number;
  code: string;
  /** null only checks that the code loads and defines read(). */
  file: ReaderFile | null;
  budgetMs: number;
  memoryBytes: number;
  outputBytes: number;
}

export type FailureKind =
  | "syntax"
  | "load-threw"
  | "no-read"
  | "threw"
  | "timeout"
  | "memory"
  | "stack"
  | "too-big"
  | "promise"
  | "no-output"
  | "unserializable"
  | "too-large"
  | "bad-records"
  | "crashed";

export interface BoxFailure {
  kind: FailureKind;
  /** Loading the code (running its top level, finding read) or reading the file. */
  phase: "load" | "read";
  detail: string;
}

export type BoxOutcome = { ok: true; records: ReaderRecord[] } | { ok: false; failure: BoxFailure };

/** retire: QuickJS itself failed (not the reader's code), so this worker's WASM memory can't be trusted. */
export interface BoxReply {
  id: number;
  outcome: BoxOutcome;
  retire: boolean;
}

/** What the worker posts: one ready message once QuickJS is loaded, then one reply per job. */
export type WorkerMessage = { ready: true } | BoxReply;

type VmOutcome = { ok: true; json: string | null } | { ok: false; failure: BoxFailure };

/** One QuickJS runtime and context with the job's limits, and every handle made in it. */
class Box {
  readonly vm: QuickJSContext;
  phase: BoxFailure["phase"] = "load";
  private readonly runtime: QuickJSRuntime;
  private readonly deadline: number;
  private readonly handles: QuickJSHandle[] = [];

  constructor(memoryBytes: number, deadline: number) {
    this.deadline = deadline;
    this.runtime = quickjs.newRuntime();
    this.runtime.setMemoryLimit(memoryBytes);
    this.runtime.setMaxStackSize(STACK_BYTES);
    this.runtime.setInterruptHandler(() => performance.now() > deadline);
    this.vm = this.runtime.newContext();
  }

  keep<T extends QuickJSHandle>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }

  fail(kind: FailureKind, detail = ""): VmOutcome {
    return { ok: false, failure: { kind, phase: this.phase, detail } };
  }

  /** A failure from something the VM threw; running out of time, memory, or stack wins over `kind`. */
  thrown(kind: FailureKind, error: QuickJSHandle): VmOutcome {
    this.keep(error);
    if (performance.now() > this.deadline) return this.fail("timeout");
    const { name, message, text, unreadable } = describeThrown(this.vm, error);
    // Out of memory, QuickJS sometimes can't finish building its error object either.
    if (unreadable) return this.fail("memory");
    if (name === "InternalError" && message === "interrupted") return this.fail("timeout");
    if (name === "InternalError" && message.startsWith("out of memory")) return this.fail("memory");
    if (message === "stack overflow") return this.fail("stack");
    return this.fail(kind, text);
  }

  dispose(): void {
    for (const handle of this.handles.reverse()) if (handle.alive) handle.dispose();
    this.vm.dispose();
    this.runtime.dispose();
  }
}

function runJob(job: BoxJob): BoxReply {
  let box: Box | undefined;
  let outcome: VmOutcome;
  try {
    box = new Box(job.memoryBytes, performance.now() + job.budgetMs);
    outcome = runInBox(box, job);
  } catch (error) {
    // The QuickJS API threw rather than returning the VM's error: usually the reader overflowed the
    // native stack in a part of QuickJS that doesn't check it. Disposing now could abort, so don't.
    return { id: job.id, outcome: { ok: false, failure: crashFailure(error, box?.phase ?? "load") }, retire: true };
  }
  let retire = false;
  try {
    box.dispose();
  } catch {
    retire = true;
  }
  if (!outcome.ok) return { id: job.id, outcome, retire };
  return { id: job.id, outcome: outcome.json === null ? { ok: true, records: [] } : checkOutput(outcome.json), retire };
}

function runInBox(box: Box, job: BoxJob): VmOutcome {
  const { vm } = box;
  // Taken before the reader's code runs, so a reader can't swap it out for itself.
  const json = box.keep(vm.getProp(vm.global, "JSON"));
  const stringify = box.keep(vm.getProp(json, "stringify"));

  if (job.file === null) {
    // Compile once on its own, so a syntax error isn't mistaken for the code throwing as it runs.
    const compiled = vm.evalCode(job.code, FILENAME, { type: "global", compileOnly: true });
    if (compiled.error) return box.thrown("syntax", compiled.error);
    box.keep(compiled.value);
  }
  const loaded = vm.evalCode(job.code, FILENAME, { type: "global" });
  if (loaded.error) return box.thrown("load-threw", loaded.error);
  box.keep(loaded.value);
  const found = vm.evalCode(`typeof read === "function" ? read : undefined`, "sandbox.js", { type: "global" });
  if (found.error) return box.thrown("load-threw", found.error);
  const read = box.keep(found.value);
  if (vm.typeof(read) !== "function") return box.fail("no-read");
  if (job.file === null) return { ok: true, json: null };

  box.phase = "read";
  // The file goes in as two strings set on a fresh object; its text is never part of any code.
  const name = box.keep(vm.newString(job.file.name));
  const text = box.keep(vm.newString(job.file.text));
  if (vm.typeof(name) !== "string" || vm.typeof(text) !== "string") return box.fail("too-big");
  const file = box.keep(vm.newObject());
  vm.setProp(file, "name", name);
  vm.setProp(file, "text", text);

  const called = vm.callFunction(read, vm.undefined, file);
  if (called.error) return box.thrown("threw", called.error);
  const result = box.keep(called.value);
  if (isPromise(box, result)) return box.fail("promise");

  const encoded = vm.callFunction(stringify, vm.undefined, result);
  if (encoded.error) return box.thrown("unserializable", encoded.error);
  const output = box.keep(encoded.value);
  if (vm.typeof(output) !== "string") return box.fail("no-output");
  // Each UTF-16 unit is at least one UTF-8 byte, so a length over the limit is over it in bytes too,
  // and the string needn't be copied out to find that.
  const length = vm.getNumber(box.keep(vm.getProp(output, "length")));
  if (length > job.outputBytes) return box.fail("too-large", String(length));
  const out = vm.getString(output);
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > job.outputBytes) return box.fail("too-large", String(bytes));
  return { ok: true, json: out };
}

function isPromise(box: Box, value: QuickJSHandle): boolean {
  if (box.vm.typeof(value) !== "object") return false;
  const state = box.vm.getPromiseState(value);
  if (state.type === "fulfilled") {
    if (state.notAPromise) return false;
    box.keep(state.value);
  } else if (state.type === "rejected") {
    box.keep(state.error);
  }
  return true;
}

/** The host's side of the output: plain JSON text, parsed here and checked like any reader's records. */
function checkOutput(json: string): BoxOutcome {
  try {
    return { ok: true, records: checkRecords(JSON.parse(json)) };
  } catch (error) {
    return { ok: false, failure: { kind: "bad-records", phase: "read", detail: error instanceof Error ? error.message : String(error) } };
  }
}

interface Thrown {
  name: string;
  message: string;
  /** A short line: "TypeError: cannot read property 'x' of undefined (line 4)". */
  text: string;
  /** An object whose contents can't be read at all. */
  unreadable: boolean;
}

function describeThrown(vm: QuickJSContext, error: QuickJSHandle): Thrown {
  let dumped: unknown;
  try {
    dumped = vm.dump(error);
  } catch {
    dumped = undefined;
  }
  if (dumped !== null && typeof dumped === "object" && ("message" in dumped || "name" in dumped)) {
    const fields = dumped as { name?: unknown; message?: unknown; stack?: unknown; lineNumber?: unknown };
    const name = String(fields.name ?? "Error");
    const message = String(fields.message ?? "");
    const line = String(fields.stack ?? "").match(/reader\.js:(\d+)/)?.[1] ?? (typeof fields.lineNumber === "number" ? fields.lineNumber : undefined);
    return { name, message, text: clip(`${name}: ${message}${line === undefined ? "" : ` (line ${line})`}`), unreadable: false };
  }
  const blank = dumped === undefined || dumped === null || dumped === "";
  const unreadable = blank && vm.typeof(error) === "object" && !vm.sameValue(error, vm.null);
  const text = typeof dumped === "string" ? dumped : (JSON.stringify(dumped) ?? String(dumped));
  return { name: "", message: "", text: clip(text || "(an empty string)"), unreadable };
}

function crashFailure(error: unknown, phase: BoxFailure["phase"]): BoxFailure {
  if (error instanceof RangeError && /call stack/i.test(error.message)) return { kind: "stack", phase, detail: "" };
  return { kind: "crashed", phase, detail: clip(error instanceof Error ? error.message : String(error)) };
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

if (!parentPort) throw new Error("sandbox-worker.ts runs as sandbox.ts's worker thread.");
const port = parentPort;
const quickjs = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
port.on("message", (job: BoxJob) => port.postMessage(runJob(job) satisfies WorkerMessage));
port.postMessage({ ready: true } satisfies WorkerMessage);
