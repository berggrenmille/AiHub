// Caps the daemon enforces (DESIGN.md › Recruitment and delegation). Rules live in code, not in prompts.

/** Active supervisors at most. A recruitment proposal beyond it says so and can't be approved. */
export const SUPERVISOR_LIMIT = 8;

/** Model turns per local day across the office. Background work defers when it runs out. */
export const DAILY_TURN_LIMIT = 80;

/** Questions one staff member may have waiting for answers at once. */
export const OPEN_QUESTIONS_LIMIT = 3;

/** Tasks the Chief of Staff may have under way at once. */
export const OPEN_TASKS_LIMIT = 4;

/** Runs a question may use: the answer, with no follow-up. */
export const QUESTION_RUNS = 1;

/** Runs a task may use by default, including follow-ups once what it asked for arrives. */
export const TASK_RUNS = 3;

/** Workers one supervisor may have on staff at once. */
export const WORKERS_PER_SUPERVISOR = 2;

/** Runs a worker's task may use: the work and one revision. */
export const WORKER_RUNS = 2;

/** Readers being written at once. */
export const READERS_DRAFTING_LIMIT = 2;

/** Runs a toolsmith's task may use. It tests as often as it likes within the one run. */
export const READER_RUNS = 1;

/** Rounds a meeting may have. The UI shows it too, so it lives with the shared types. */
export { MEETING_ROUNDS } from "@aihub/shared";

/** Tasks one meeting's conclusion may hand out. */
export const MEETING_TASKS = 4;

/** Decisions one meeting's conclusion may record. */
export const MEETING_DECISIONS = 8;
