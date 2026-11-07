import type { ActivityEntry } from "@aihub/shared";
import { activityTone, formatDateTime, formatFeedTime } from "../format.ts";

interface ActivityFeedProps {
  entries: ActivityEntry[];
  agentName(agentId: string | null): string;
}

export function ActivityFeed({ entries, agentName }: ActivityFeedProps) {
  const now = new Date();
  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <h2 className="panel-title" id="activity-title">
        Activity
      </h2>
      <div className="panel-body">
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
    </section>
  );
}
