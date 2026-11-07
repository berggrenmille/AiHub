import { seedSampleStaff, SAMPLE_STAFF } from "./briefing/samples.ts";
import type { Office } from "./office.ts";
import { CHIEF_OF_STAFF_CONVERSATION_ID, CHIEF_OF_STAFF_ID } from "./staff/chief-of-staff.ts";

// A furnished office for the fake runtime (`npm run dev:fake`), so the UI has staff, notes, items,
// a proposal, and some motion to show without Codex. Never used with the real runtime.

const RESPONSIBILITIES: Record<string, { title: string; scope: string }> = {
  "work-schedule": { title: "Work schedule", scope: "Changes, conflicts, and preparation in the work calendar." },
  "work-inbox": { title: "Work inbox", scope: "Decisions and deadlines in the work mailbox." },
  "personal-inbox": { title: "Personal inbox", scope: "Bills, renewals, deliveries, and replies in the personal mailbox." },
  portfolio: { title: "Portfolio", scope: "Holdings and watchlist events against the review rules." },
};

/** Seeds the sample office once, into an empty fake-runtime database. */
export function seedDemoOffice(office: Office) {
  const { store, notebook } = office;
  if (store.countActive("supervisor") > 0) return;
  seedSampleStaff(store);
  const chief = store.getAgentRecord(CHIEF_OF_STAFF_ID)!;
  const responsibilities = new Map<string, string>();
  for (const agent of SAMPLE_STAFF) {
    const responsibility = store.createResponsibility({ ownerId: agent.id, ...RESPONSIBILITIES[agent.id]!, standingInstructions: "", expiresAt: null });
    responsibilities.set(agent.id, responsibility.id);
    store.createRoutine({
      ownerId: agent.id,
      responsibilityId: responsibility.id,
      title: `${responsibility.title} for the briefing`,
      trigger: { type: "briefing" },
      timezone: "Europe/Stockholm",
      dailyTurnBudget: 4,
    });
  }
  store.createRoutine({
    ownerId: CHIEF_OF_STAFF_ID,
    responsibilityId: null,
    title: "Morning briefing",
    trigger: { type: "weekdays", time: "07:00" },
    timezone: "Europe/Stockholm",
    dailyTurnBudget: 6,
  });

  const calendar = store.createConnection({ kind: "ics_file", label: "Work calendar", path: "C:/Users/demo/work.ics" });
  store.setConnectionStatus(calendar.id, "connected", "42 events in the next week");
  store.grant("work-schedule", calendar.id, ["read"]);
  // Saga waits for her mailbox, so the office shows someone waiting for access.
  const mailbox = store.createConnection({ kind: "ics_file", label: "Personal mailbox", path: "" });
  store.grant("personal-inbox", mailbox.id, ["read"]);

  const schedule = responsibilities.get("work-schedule")!;
  const item = (key: string, title: string, detail: string, urgency: "urgent" | "today" | "this_week" | "fyi") =>
    store.upsertItem({ responsibilityId: schedule, sourceKey: key, sourceVersion: "v1", title, detail, urgency, expiresAt: null }).item;
  const reported = [
    item("evt-4471", "Q4 planning moved to 10:00", "It now overlaps the project review at 10:30. Anna Lindqvist moved it.", "today"),
    item("evt-4519", "1:1 with Erik on Friday", "Erik wants to discuss the on-call rota.", "this_week"),
  ];
  store.markReported(reported.map((reportedItem) => reportedItem.id));
  item("evt-4390", "Vendor demo cancelled", "Tuesday 13:00 is free again.", "fyi");
  const portfolio = responsibilities.get("portfolio")!;
  store.upsertItem({
    responsibilityId: portfolio,
    sourceKey: "hold-SAND",
    sourceVersion: "2026-11-07",
    title: "Sandvik fell 8.4%",
    detail: "Past the 7% review rule after a profit warning. 6.2% of the portfolio.",
    urgency: "urgent",
    expiresAt: null,
  });

  const runId = null;
  notebook.writeFor(chief, "demo", "conversation", {
    title: "Operator preferences",
    body: "- Briefing at 07:00 on weekdays, short.\n- Flag anything about money the same day.\n- Prefers meetings before lunch.",
    mode: "replace",
    folder: "office",
  });
  notebook.writeFor(store.getAgentRecord("work-schedule")!, "demo", "data", {
    title: "Anna Lindqvist",
    body: "Runs Q4 planning. Moves meetings at short notice; check her invites first. See [[Q4 planning]].",
    mode: "replace",
    folder: "own",
  });
  notebook.writeFor(store.getAgentRecord("work-schedule")!, "demo", "conversation", {
    title: "Q4 planning",
    body: "Recurring Monday meeting with [[Anna Lindqvist]]. The operator wants prep notes the Friday before.",
    mode: "replace",
    folder: "own",
  });
  notebook.writeFor(store.getAgentRecord("portfolio")!, "demo", "conversation", {
    title: "Review rules",
    body: "- A holding down 7% or more in a day.\n- Earnings within two days.\nSet by the operator; see [[Operator preferences]].",
    mode: "replace",
    folder: "own",
  });

  const proposal = store.createProposal({
    proposedBy: CHIEF_OF_STAFF_ID,
    runId,
    payload: {
      profile: {
        name: "Rut",
        title: "Bookkeeping Supervisor",
        description: "Keeps the household books: sorts receipts and bank exports, and flags what doesn't add up.",
        workingStyle: "Careful with numbers. Asks before guessing.",
      },
      responsibility: {
        title: "Household bookkeeping",
        scope: "Monthly bank exports and receipts.",
        standingInstructions: "Flag any charge over 2 000 kr that isn't a known bill.",
        expiresAt: null,
      },
      source: { kind: "ics_file", label: "Bank export" },
      reason: "You asked for help keeping the books.",
    },
  });
  office.postMessage(
    CHIEF_OF_STAFF_CONVERSATION_ID,
    CHIEF_OF_STAFF_ID,
    "I'd like to recruit Rut to keep your books. Approve the card when you're ready.",
    runId,
    "proposal",
    proposal.id,
  );
  office.syncProfiles();
}

/** Starts a fake run for a random supervisor now and then, so the office has motion. */
export function startDemoActivity(office: Office, everyMs = 20_000): () => void {
  const chores = ["Checking for changes", "Reading new records", "Tidying notes", "Preparing the briefing section"];
  const timer = setInterval(() => {
    const staff = office.store.listAgents().filter((agent) => agent.role !== "chief_of_staff" && agent.state === "idle");
    const agent = staff[Math.floor(Math.random() * staff.length)];
    if (!agent) return;
    void office
      .runTask({
        agentId: agent.id,
        kind: "report",
        title: chores[Math.floor(Math.random() * chores.length)]!,
        instructions: "Demo run.",
        input: "Nothing new.",
      })
      .catch(() => {});
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
