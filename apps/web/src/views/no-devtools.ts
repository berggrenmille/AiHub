// OpenUI's React package mounts its Inspect devtools on any page in a development build. AiHub doesn't
// want a third-party panel, with its links to an outside cloud service, in the office even then. The
// package checks this flag before mounting, so it must be set before the package loads: import this first.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

export {};
