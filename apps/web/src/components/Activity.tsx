import { useEffect, useRef, useState } from "react";
import type { ActivityEntry, ActivityKind } from "@aihub/shared";
import { activityLine, activityTone, formatDateTime, formatFeedTime } from "../format.ts";
import { Icon } from "./Icon.tsx";

// Activity as a ticker along the bottom, toasts for what matters, and the full log on demand.

interface TickerProps {
  entries: ActivityEntry[];
  agentName(agentId: string | null): string;
  onOpenLog(): void;
}

export function ActivityTicker({ entries, agentName, onOpenLog }: TickerProps) {
  const latest = entries.slice(0, 6);
  return (
    <footer className="ticker" aria-label="Latest activity">
      <button type="button" className="ticker-log" onClick={onOpenLog}>
        <Icon name="activity" size={16} /> Activity log
      </button>
      <ol className="ticker-items">
        {latest.length === 0 && <li className="muted">Quiet so far.</li>}
        {latest.map((entry) => {
          const line = activityLine(agentName(entry.agentId), entry.summary);
          return (
            <li key={entry.id} className={`ticker-item tone-${activityTone(entry.kind)} kind-${entry.kind}`}>
              <span className="feed-marker" aria-hidden="true" />
              <time dateTime={entry.at} title={formatDateTime(entry.at)}>
                {formatFeedTime(entry.at).slice(0, 5)}
              </time>
              {line.who && <span className="ticker-agent">{line.who}</span>}
              <span className="ticker-summary">{line.text}</span>
            </li>
          );
        })}
      </ol>
    </footer>
  );
}

export function ActivityLog({ entries, agentName, onClose }: { entries: ActivityEntry[]; agentName(agentId: string | null): string; onClose(): void }) {
  const now = new Date();
  return (
    <aside className="drawer activity-drawer" aria-labelledby="activity-title">
      <header className="drawer-head">
        <div className="drawer-title">
          <h2 id="activity-title">Activity</h2>
          <p className="muted small">Everything the office did, newest first</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Close the activity log">
          <Icon name="close" />
          <span className="visually-hidden">Close the activity log</span>
        </button>
      </header>
      <div className="drawer-body">
        {entries.length === 0 ? (
          <p className="empty">Nothing has happened yet.</p>
        ) : (
          <ol className="feed">
            {entries.map((entry) => (
              <li key={entry.id} className={`feed-item tone-${activityTone(entry.kind)}`}>
                <span className="feed-marker" aria-hidden="true" />
                <div className="feed-text">
                  <p className="feed-meta">
                    <span className="feed-agent">{agentName(entry.agentId)}</span>
                    <time dateTime={entry.at} title={formatDateTime(entry.at)}>
                      {formatFeedTime(entry.at, now)}
                    </time>
                  </p>
                  <p className="feed-summary">{entry.summary}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

/** Kinds worth a toast: outcomes and things that need the operator. */
const TOAST_KINDS: ReadonlySet<ActivityKind> = new Set([
  "run_finished",
  "run_failed",
  "proposal",
  "approved",
  "declined",
  "item",
  "briefing",
  "health",
  "blocked",
  "tool_refused",
  "responsibility_ended",
  // Questions asked, tasks delivered or failed, and workers joining or leaving a team.
  "assignment",
  "worker",
]);

const TOAST_MS = 6000;
const MAX_TOASTS = 3;

/** Shows a toast for each new activity entry that matters. Entries already there on load don't count. */
export function Toasts({ entries, loaded, agentName }: { entries: ActivityEntry[]; loaded: boolean; agentName(agentId: string | null): string }) {
  const seen = useRef<number | null>(null);
  const [toasts, setToasts] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    if (!loaded) return;
    const newest = entries[0]?.id ?? 0;
    if (seen.current === null) {
      seen.current = newest;
      return;
    }
    const fresh = entries.filter((entry) => entry.id > seen.current! && TOAST_KINDS.has(entry.kind)).reverse();
    seen.current = Math.max(seen.current, newest);
    if (fresh.length === 0) return;
    setToasts((current) => [...current, ...fresh].slice(-MAX_TOASTS));
    // Not cleared when entries change again: each batch leaves on its own schedule.
    setTimeout(() => setToasts((current) => current.filter((toast) => !fresh.includes(toast))), TOAST_MS);
  }, [entries, loaded]);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const line = activityLine(agentName(toast.agentId), toast.summary);
        return (
          <div key={toast.id} className={`toast tone-${activityTone(toast.kind)} kind-${toast.kind}`}>
            <span className="feed-marker" aria-hidden="true" />
            <p>
              {line.who && <strong>{line.who}</strong>} {line.text}
            </p>
            <button type="button" className="icon-button small" onClick={() => setToasts((current) => current.filter((other) => other !== toast))} title="Dismiss">
              <Icon name="close" size={14} />
              <span className="visually-hidden">Dismiss</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
