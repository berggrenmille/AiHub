// Milestone 5: produces the Codex failures that can be produced without harm, and shows how AiHub
// reads them and what the operator is told (DESIGN.md › Build sequence and acceptance). Nothing here
// signs the real account out or spends usage: a signed-out Codex is one started with an empty
// CODEX_HOME, and an offline one sends its requests to a closed port on this PC. The clock is set to
// a Monday morning so the health check and the briefing fall due. Sign in first: `npm run codex -- login`.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { Office } from "../src/office.ts";
import { RecordingPlatform } from "../src/platform.ts";
import { CodexRuntime, pinnedCodexCommand } from "../src/runtime/codex-runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "../src/staff/chief-of-staff.ts";
import { Store } from "../src/store/store.ts";

const config = loadConfig();
const SAMPLE = fileURLToPath(new URL("../test/fixtures/work.ics", import.meta.url));
// A Monday: 05:10Z is 06:10 in Stockholm, inside the hour before the 07:00 briefing.
const HEALTH = new Date("2026-11-09T05:10:00.000Z");
const BRIEFING = new Date("2026-11-09T06:00:00.000Z");
const dirs: string[] = [];

/** An office with one supervisor watching a calendar export, on the given runtime and clock. */
function officeOn(runtime: CodexRuntime, clock: { now: Date }) {
  const dir = mkdtempSync(join(tmpdir(), "aihub-probe-"));
  dirs.push(dir);
  const calendar = join(dir, "work.ics");
  copyFileSync(SAMPLE, calendar);
  const store = new Store(":memory:", () => clock.now);
  const platform = new RecordingPlatform();
  const office = new Office({ store, runtime, platform, vaultDir: join(dir, "vault"), turnTimeoutMs: 4 * 60_000 });
  office.start();
  store.upsertAgent({ id: "work-schedule", name: "Elin", title: "Work Schedule Supervisor", role: "supervisor", managerId: CHIEF_OF_STAFF_ID, profile: "data", charter: "" });
  const responsibility = store.createResponsibility({ ownerId: "work-schedule", title: "Work schedule", scope: "", standingInstructions: "", expiresAt: null });
  store.createRoutine({ ownerId: "work-schedule", responsibilityId: responsibility.id, title: "Work schedule", trigger: { type: "briefing" }, timezone: "Europe/Stockholm", dailyTurnBudget: 4 });
  const connection = store.createConnection({ kind: "ics_file", label: "Work calendar", path: calendar });
  store.grant("work-schedule", connection.id, ["read"]);
  const scheduler = new Scheduler(office, { now: () => clock.now });
  const at = async (when: Date) => {
    clock.now = when;
    await scheduler.tick();
    await scheduler.idle();
  };
  return { store, office, platform, scheduler, at };
}

function show(title: string, office: Office, platform: RecordingPlatform) {
  console.log(`\n${title}`);
  for (const message of office.store.recentMessages(20, CHIEF_OF_STAFF_CONVERSATION_ID)) {
    if (message.kind === "notice") console.log(`  Chat notice: ${message.body.replace(/\n/g, "\n    ")}`);
  }
  for (const notification of platform.notifications) console.log(`  Notification: ${notification.title} | ${notification.body.replace(/\n/g, " / ")}`);
}

try {
  // 1. The plan's usage, as the health check and the waiting briefing read it.
  const signedIn = new CodexRuntime({ command: pinnedCodexCommand(config.root), codexHome: config.codexHome });
  console.log("Account:", await signedIn.account());
  console.log("Usage:", await signedIn.usageLimits());
  await signedIn.close();

  // 2. Signed out: the health check catches it, and the briefing waits instead of failing.
  const emptyHome = mkdtempSync(join(tmpdir(), "aihub-codex-home-"));
  dirs.push(emptyHome);
  const signedOut = new CodexRuntime({ command: pinnedCodexCommand(config.root), codexHome: emptyHome });
  const out = officeOn(signedOut, { now: HEALTH });
  await out.at(HEALTH);
  await out.at(BRIEFING);
  const waiting = out.store.getOccurrence(`${out.store.listRoutines().find((routine) => routine.trigger.type === "weekdays")!.id}:2026-11-09`);
  show("Signed out", out.office, out.platform);
  console.log(`  Occurrence: ${waiting?.status}, tries again at ${waiting?.retryAt}; model turns: ${out.store.recentRuns(20).reduce((sum, run) => sum + run.turns, 0)}`);
  console.log(`  Wake timer: ${out.platform.wake?.toISOString()}; awake: ${out.platform.awake}`);
  await signedOut.close();

  // 3. Offline: requests go to a closed port, so Codex never reaches the service.
  const closed = "http://127.0.0.1:9";
  const offline = new CodexRuntime({
    command: pinnedCodexCommand(config.root),
    codexHome: config.codexHome,
    env: { HTTPS_PROXY: closed, HTTP_PROXY: closed, ALL_PROXY: closed, https_proxy: closed, http_proxy: closed, all_proxy: closed, NO_PROXY: "", no_proxy: "" },
  });
  const off = officeOn(offline, { now: BRIEFING });
  const started = Date.now();
  await off.at(BRIEFING);
  const report = off.store.recentRuns(20).find((run) => run.kind === "report");
  show("Offline", off.office, off.platform);
  console.log(`  Report run: ${report?.state}, ${report?.error}`);
  const briefingRun = off.store.recentRuns(20).find((run) => run.kind === "briefing");
  console.log(`  Briefing run: ${briefingRun?.state}, ${briefingRun?.error}; took ${Math.round((Date.now() - started) / 1000)} s`);
  // A turn tried anyway, past the check: what Codex reports and how AiHub sorts it.
  try {
    const contextId = await offline.startContext({ profile: "conversation", instructions: "Reply in one word.", tools: [], ephemeral: true });
    const turnStarted = Date.now();
    const turn = await offline.runTurn(contextId, { input: "Say hi.", onToolCall: async () => ({ ok: false, text: "" }), timeoutMs: 4 * 60_000 });
    console.log(`  A turn tried anyway: ${turn.status}, blocker ${turn.blocker}, after ${Math.round((Date.now() - turnStarted) / 1000)} s: ${turn.error}`);
    console.log("  The check a briefing runs after such a failure:", await off.office.readiness());
  } catch (error) {
    console.log(`  A turn tried anyway couldn't start: ${error instanceof Error ? error.message : String(error)}`);
  }
  await offline.close();
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
