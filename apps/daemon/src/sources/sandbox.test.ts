import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ReaderCodeError, loadSandbox, runReader, type SandboxRun } from "./sandbox.ts";

const CSV_READER = `
function read(file) {
  const [header, ...rows] = file.text.trim().split("\\n");
  const columns = header.split(",");
  return rows.map((row) => {
    const cells = row.split(",");
    const fields = {};
    columns.forEach((column, i) => { fields[column] = isNaN(Number(cells[i])) ? cells[i] : Number(cells[i]); });
    return { key: cells[0], title: cells[1], fields };
  });
}`;

/** The only globals a reader may see: the language's own (ECMAScript, plus QuickJS's InternalError). */
const LANGUAGE_GLOBALS = new Set(
  `globalThis Infinity NaN undefined eval isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent encodeURI
  encodeURIComponent escape unescape AggregateError Array ArrayBuffer AsyncDisposableStack Atomics BigInt BigInt64Array
  BigUint64Array Boolean DataView Date DisposableStack Error EvalError FinalizationRegistry Float16Array Float32Array
  Float64Array Function Int8Array Int16Array Int32Array InternalError Iterator JSON Map Math Number Object Promise Proxy
  RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer String SuppressedError Symbol SyntaxError TypeError
  URIError Uint8Array Uint8ClampedArray Uint16Array Uint32Array WeakMap WeakRef WeakSet`.split(/\s+/),
);

const errorFor = (run: SandboxRun, file: string) => run.errors.find((entry) => entry.file === file)?.error;
const recordsFor = (run: SandboxRun, file: string) => run.records.find((entry) => entry.file === file)?.records;

describe("Reader sandbox", () => {
  before(() => loadSandbox());

  it("reads files into checked records", async () => {
    const run = await runReader(CSV_READER, [
      { name: "books.csv", text: "id,title,year\n1,  Dune ,1965\n2,Solaris,1961\n" },
      { name: "empty.csv", text: "id,title\n" },
    ]);
    assert.deepEqual(run.errors, []);
    assert.deepEqual(recordsFor(run, "books.csv"), [
      { key: "1", title: "Dune", fields: { id: 1, title: "Dune", year: 1965 } },
      { key: "2", title: "Solaris", fields: { id: 2, title: "Solaris", year: 1961 } },
    ]);
    assert.deepEqual(recordsFor(run, "empty.csv"), []);
  });

  it("hands the file in as data, never as code", async () => {
    const text = "\"); globalThis.injected = true; (\"`${globalThis.injected = true}`\n*/ globalThis.injected = true; /*";
    const run = await runReader(
      `function read(file) { return [{ title: file.name, fields: { text: file.text, injected: typeof injected } }]; }`,
      [{ name: "'); globalThis.injected = true; ('", text }],
    );
    assert.deepEqual(recordsFor(run, "'); globalThis.injected = true; ('")?.[0]?.fields, { text: text.trim(), injected: "undefined" });
  });

  describe("keeps the host out of reach", () => {
    let folder = "";
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("export default 1;");
    });
    before(async () => {
      folder = mkdtempSync(join(tmpdir(), "aihub-sandbox-"));
      writeFileSync(join(folder, "canary.txt"), "CANARY-4f9e1c");
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });
    after(() => {
      server.close();
      rmSync(folder, { recursive: true, force: true });
    });

    it("has no host objects, and every way out fails without touching files or the network", async () => {
      const port = (server.address() as AddressInfo).port;
      const canary = join(folder, "canary.txt");
      const written = join(folder, "written.txt");
      const probe = `
        function attempt(fn) {
          try { const value = fn(); return value === undefined ? "undefined" : typeof value === "object" ? "object" : String(value); }
          catch (error) { return "threw " + (error && error.name); }
        }
        function read(file) {
          const { canary, written, url } = JSON.parse(file.text);
          const fields = {};
          for (const name of ["require", "process", "module", "exports", "global", "Buffer", "fetch", "XMLHttpRequest",
            "WebSocket", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "console", "std", "os", "print",
            "scriptArgs", "Deno", "Bun", "WebAssembly", "importScripts", "navigator", "location"]) {
            fields["typeof " + name] = eval("typeof " + name);
          }
          fields.require = attempt(() => require("fs").readFileSync(canary, "utf8"));
          fields.process = attempt(() => process.binding("fs"));
          fields.fetch = attempt(() => fetch(url));
          fields.xhr = attempt(() => { const x = new XMLHttpRequest(); x.open("GET", url, false); x.send(); return x.responseText; });
          fields.loadFile = attempt(() => std.loadFile(canary));
          fields.writeFile = attempt(() => os.open(written, 1));
          fields.timer = attempt(() => setTimeout(() => {}, 0));
          // import() only queues a job, and the sandbox never runs queued jobs: nothing below ever happens.
          const imported = import("node:fs");
          imported.then((fs) => fs.writeFileSync(written, "escaped"));
          import(url).then(() => {});
          import("file:///" + canary).then(() => {});
          fields.import = typeof imported;
          fields.functionThis = Function("return this")() === globalThis;
          fields.functionProcess = Function("return typeof process")();
          fields.constructorEscape = ({}).constructor.constructor("return typeof require")();
          fields.indirectEval = (0, eval)("typeof process");
          fields.globals = Object.getOwnPropertyNames(globalThis).join(" ");
          return [{ title: "probe", fields }];
        }`;
      const run = await runReader(probe, [{ name: "probe.json", text: JSON.stringify({ canary, written, url: `http://127.0.0.1:${port}/` }) }]);
      assert.deepEqual(run.errors, []);
      const fields = recordsFor(run, "probe.json")![0]!.fields;

      for (const [name, value] of Object.entries(fields)) {
        if (name.startsWith("typeof ")) assert.equal(value, "undefined", name);
      }
      for (const name of ["require", "process", "fetch", "xhr", "loadFile", "writeFile", "timer"]) {
        assert.equal(fields[name], "threw ReferenceError", name);
      }
      assert.equal(fields.import, "object");
      assert.equal(fields.functionThis, true, "Function('return this') is the sandbox's own global");
      assert.equal(fields.functionProcess, "undefined");
      assert.equal(fields.constructorEscape, "undefined");
      assert.equal(fields.indirectEval, "undefined");
      const strange = String(fields.globals).split(" ").filter((name) => !["read", "attempt"].includes(name) && !LANGUAGE_GLOBALS.has(name));
      assert.deepEqual(strange, [], "globals beyond the language itself");

      assert.ok(!JSON.stringify(run).includes("CANARY"), "the canary file's text never comes back");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(hits, 0, "nothing reached the network");
      assert.equal(existsSync(written), false, "nothing was written");
    });
  });

  it("stops an endless loop at the per-file deadline, and the next file still runs", async () => {
    const run = await runReader(
      `function read(file) { if (file.name === "loop.txt") for (;;) {} return [{ title: file.name }]; }`,
      [{ name: "loop.txt", text: "" }, { name: "next.txt", text: "" }],
      { msPerFile: 300 },
    );
    assert.equal(errorFor(run, "loop.txt"), "read() took longer than 300 ms and was stopped.");
    assert.equal(recordsFor(run, "next.txt")?.[0]?.title, "next.txt");
  });

  it("kills a native loop QuickJS can't interrupt, and the next file still runs", async () => {
    // indexOf on a huge array-like never polls QuickJS's interrupt handler: only killing the worker stops it.
    const started = performance.now();
    const run = await runReader(
      `function read(file) { if (file.name === "stuck.txt") Array.prototype.indexOf.call({ length: 2 ** 40 }, 1); return [{ title: file.name }]; }`,
      [{ name: "stuck.txt", text: "" }, { name: "next.txt", text: "" }],
      { msPerFile: 300 },
    );
    assert.equal(errorFor(run, "stuck.txt"), "read() took longer than 300 ms and was stopped.");
    assert.equal(recordsFor(run, "next.txt")?.[0]?.title, "next.txt");
    assert.ok(performance.now() - started < 5_000, "the stuck file was given up on");
  });

  it("stops a slow run at the total deadline", async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ name: `slow${i}.txt`, text: "" }));
    const started = performance.now();
    const run = await runReader(
      `function read(file) { const start = Date.now(); while (Date.now() - start < 200) {} return [{ title: file.name }]; }`,
      files,
      { msPerFile: 1_000, msTotal: 500 },
    );
    const elapsed = performance.now() - started;
    assert.ok(run.records.length >= 1 && run.records.length <= 3, `${run.records.length} files read`);
    assert.equal(run.records.length + run.errors.length, files.length);
    assert.ok(run.errors.every((entry) => /^(Stopped|Not read): reading all the files took longer than 500 ms\.$/.test(entry.error)), JSON.stringify(run.errors));
    assert.ok(elapsed < 2_000, `took ${Math.round(elapsed)} ms`);
  });

  it("fails cleanly when a reader allocates without bound, and later runs still work", async () => {
    const hungry = `
      function read(file) {
        if (file.name === "numbers.txt") { const all = []; for (let i = 0; ; i++) all.push(i); }
        if (file.name === "records.txt") { const all = []; for (let i = 0; ; i++) all.push({ key: String(i), title: "row " + i }); }
        if (file.name === "kept.txt") { globalThis.kept = []; for (;;) kept.push(new Uint8Array(1e6)); }
        return [{ title: file.name }];
      }`;
    const run = await runReader(
      hungry,
      ["numbers.txt", "records.txt", "kept.txt", "fine.txt"].map((name) => ({ name, text: "" })),
      { msPerFile: 5_000, memoryBytes: 16 * 1024 * 1024 },
    );
    for (const file of ["numbers.txt", "records.txt", "kept.txt"]) {
      assert.equal(errorFor(run, file), "read() ran out of memory (the limit is 16 MB per file).", file);
    }
    assert.equal(recordsFor(run, "fine.txt")?.[0]?.title, "fine.txt");

    const again = await runReader(CSV_READER, [{ name: "a.csv", text: "id,title\n1,One" }]);
    assert.deepEqual(again.errors, []);
    assert.equal(recordsFor(again, "a.csv")?.[0]?.title, "One");
  });

  it("fails cleanly on deep recursion and deep nesting", async () => {
    const deep = `
      function read(file) {
        if (file.name === "recurse.txt") { const down = (n) => down(n + 1) + 1; down(0); }
        if (file.name === "nested.json") JSON.parse(file.text);
        if (file.name === "parse.txt") eval("(".repeat(100000) + "1" + ")".repeat(100000));
        return [{ title: file.name }];
      }`;
    const run = await runReader(deep, [
      { name: "recurse.txt", text: "" },
      { name: "nested.json", text: "[".repeat(200_000) + "]".repeat(200_000) },
      { name: "parse.txt", text: "" },
      { name: "fine.txt", text: "" },
    ]);
    for (const file of ["recurse.txt", "nested.json", "parse.txt"]) {
      assert.equal(errorFor(run, file), "read() recursed or nested too deeply (stack overflow).", file);
    }
    assert.equal(recordsFor(run, "fine.txt")?.[0]?.title, "fine.txt");
  });

  it("refuses huge output and output that isn't records", async () => {
    const reader = `
      function read(file) {
        switch (file.name) {
          case "huge": return [{ title: "x", fields: { text: "y".repeat(2000000) } }];
          case "many": return Array.from({ length: 6000 }, (_, i) => ({ key: i, title: "r" }));
          case "object": return { title: "not a list" };
          case "nothing": return;
          case "async": return Promise.resolve([]);
          case "cycle": { const a = []; a.push(a); return a; }
          case "throws": return file.missing.field;
        }
      }`;
    const run = await runReader(reader, ["huge", "many", "object", "nothing", "async", "cycle", "throws"].map((name) => ({ name, text: "" })));
    assert.equal(run.records.length, 0);
    assert.equal(errorFor(run, "huge"), "read() returned 1.9 MB of records as JSON; the limit is 1 MB per file.");
    assert.equal(errorFor(run, "many"), "A reader returns at most 5000 records for one file, not 6000.");
    assert.equal(errorFor(run, "object"), "A reader returns a list of records, not an object.");
    assert.equal(errorFor(run, "nothing"), "read() returned nothing. It must return a list of { key, title, fields } records.");
    assert.equal(errorFor(run, "async"), "read() returned a promise. Readers can't be async: return the list of records itself.");
    assert.match(errorFor(run, "cycle") ?? "", /^read\(\) returned something that can't be turned into JSON: TypeError: circular reference/);
    assert.equal(errorFor(run, "throws"), "read() threw: TypeError: cannot read property 'field' of undefined (line 10)");
  });

  it("throws a clear error when the code can't load", async () => {
    const cases: Array<[string, RegExp]> = [
      ["function read(file) {\n  return [;\n}", /^The reader has a syntax error: SyntaxError: .+ \(line 2\)\.$/],
      ["import fs from 'fs';\nfunction read() { return []; }", /syntax error.*Readers are plain scripts, so leave out import and export\.$/],
      ["const reader = (file) => [];", /^The reader doesn't define read\(\)\./],
      ["var read = 'not a function';", /^The reader doesn't define read\(\)\./],
      ["throw new Error('boom');\nfunction read() { return []; }", /^The reader's code threw while loading: Error: boom \(line 1\)$/],
      ["for (;;) {}\nfunction read() { return []; }", /^The reader's code took longer than 300 ms to load\.$/],
    ];
    for (const [code, message] of cases) {
      await assert.rejects(runReader(code, [{ name: "a.txt", text: "" }], { msPerFile: 300 }), (error: unknown) => {
        assert.ok(error instanceof ReaderCodeError, `${code}: ${String(error)}`);
        assert.match(error.message, message, code);
        return true;
      });
    }
    // A reader defined with const works as well as a function declaration.
    const run = await runReader("const read = (file) => [{ title: file.name }];", [{ name: "a.txt", text: "" }]);
    assert.equal(recordsFor(run, "a.txt")?.[0]?.title, "a.txt");
  });

  it("keeps no state between files or between runs", async () => {
    const leaky = `
      let calls = 0;
      function read(file) {
        calls += 1;
        const seen = { calls, global: typeof globalThis.left, prototype: ({}).polluted ?? null, jobs: typeof globalThis.fromJob };
        globalThis.left = file.name;
        Object.prototype.polluted = file.name;
        Array.prototype.push = () => 0;
        JSON.stringify = () => "[]";
        Promise.resolve().then(() => { globalThis.fromJob = true; });
        return [{ title: file.name, fields: seen }];
      }`;
    const run = await runReader(leaky, ["a.txt", "b.txt", "c.txt"].map((name) => ({ name, text: "" })));
    assert.deepEqual(run.errors, []);
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      assert.deepEqual(recordsFor(run, file)?.[0]?.fields, { calls: 1, global: "undefined", prototype: null, jobs: "undefined" }, file);
    }
    const next = await runReader(
      "function read() { return [{ title: 'next', fields: { global: typeof left, prototype: ({}).polluted ?? null } }]; }",
      [{ name: "next.txt", text: "" }],
    );
    assert.deepEqual(recordsFor(next, "next.txt")?.[0]?.fields, { global: "undefined", prototype: null });
  });

  it("runs calls made at the same time one after another", async () => {
    const runs = await Promise.all(
      ["one", "two", "three"].map((name) => runReader(`function read() { return [{ title: "${name}" }]; }`, [{ name: `${name}.txt`, text: "" }])),
    );
    assert.deepEqual(runs.map((run) => run.records[0]?.records[0]?.title), ["one", "two", "three"]);
  });
});
