// Caps the daemon enforces (DESIGN.md › Recruitment and delegation). Rules live in code, not in prompts.

/** Active supervisors at most. A recruitment proposal beyond it says so and can't be approved. */
export const SUPERVISOR_LIMIT = 8;

/** Model turns per local day across the office. Background work defers when it runs out. */
export const DAILY_TURN_LIMIT = 80;
