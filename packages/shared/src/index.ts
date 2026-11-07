// Types shared by the daemon and the web UI.
// Records from DESIGN.md › Staff and work model land here as they are built.

/** Run states that the roster, activity feed, and office render (DESIGN.md › The office experience). */
export type RunState =
  | "queued"
  | "collecting"
  | "working"
  | "reviewing"
  | "waiting_for_access"
  | "waiting_for_approval"
  | "done"
  | "failed";

export interface HealthResponse {
  status: "ok";
  version: string;
  startedAt: string;
}
