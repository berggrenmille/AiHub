import { useMemo, useState } from "react";
import type { Item, View } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatAgo, formatDateTime } from "../format.ts";
import { ViewFrame, type ViewActions } from "../views/LazyViewFrame.tsx";
import { Icon } from "./Icon.tsx";

// Dashboards staff made for the operator (DESIGN.md › Views). Each fetches its data from the office
// when it opens, read-only, so it is current every time. Opening one never acts; its buttons do only
// what they say, once the operator clicks them.

interface DashboardsProps {
  dashboards: View[];
  items: Item[];
  now: number;
  nameOf(agentId: string): string;
  /** Opens a staff member's chat with a message in the box, unsent. */
  onAsk(agentId: string, text: string): void;
  onResolve(itemId: number, note?: string): Promise<void>;
  onDismiss(itemId: number): Promise<void>;
  onData(tool: string, args: Record<string, unknown>): Promise<unknown>;
  onRemove(viewId: string): Promise<void>;
}

export function Dashboards(props: DashboardsProps) {
  const { dashboards } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const open = dashboards.find((view) => view.id === chosen) ?? dashboards[0] ?? null;

  if (dashboards.length === 0) {
    return (
      <section className="view dashboards dashboards-empty" aria-labelledby="dashboards-title">
        <div className="card">
          <Icon name="dashboard" size={28} />
          <h2 id="dashboards-title">No dashboards yet</h2>
          <p>
            Ask anyone on staff for one in chat, such as <q>Make me a dashboard of open items by urgency</q> or <q>Show the office's turns per day this month</q>.
          </p>
          <p className="muted">A dashboard reads the office's data each time you open it, so its numbers are always current. Opening one never changes anything.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="view dashboards" aria-label="Dashboards">
      <nav className="dashboards-list" aria-label="Your dashboards">
        <h2 className="eyebrow">Dashboards</h2>
        <ul>
          {dashboards.map((view) => (
            <li key={view.id}>
              <button type="button" aria-current={view.id === open?.id ? "page" : undefined} onClick={() => setChosen(view.id)}>
                <span className="dashboards-name">{view.title}</span>
                <span className="muted small">
                  {props.nameOf(view.agentId)} · {formatAgo(view.updatedAt, props.now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {open && <Dashboard key={open.id} view={open} {...props} />}
    </section>
  );
}

function Dashboard(props: DashboardsProps & { view: View }) {
  const { view, nameOf, onAsk, onResolve, onDismiss, onData } = props;
  const [drawn, setDrawn] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const author = nameOf(view.agentId);
  const actions = useMemo<ViewActions>(
    () => ({ ask: (text) => onAsk(view.agentId, text), resolve: onResolve, dismiss: onDismiss, data: onData }),
    [view.agentId, onAsk, onResolve, onDismiss, onData],
  );

  const remove = () => {
    setError(null);
    props.onRemove(view.id).catch((failure: unknown) => {
      setError(`Couldn't remove the dashboard: ${errorText(failure)}`);
      setConfirming(false);
    });
  };

  return (
    <article className="dashboard" aria-labelledby={`dashboard-${view.id}`}>
      <header className="dashboard-head">
        <div>
          <h2 id={`dashboard-${view.id}`}>{view.title}</h2>
          <p className="muted small">
            Made by {author} ·{" "}
            <time dateTime={view.updatedAt} title={formatDateTime(view.updatedAt)}>
              {view.createdAt === view.updatedAt ? "made" : "updated"} {formatAgo(view.updatedAt, props.now)}
            </time>
          </p>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="button ghost small" onClick={() => setDrawn((count) => count + 1)} title="Fetch its data again">
            <Icon name="refresh" size={16} />
            <span>Refresh</span>
          </button>
          <button type="button" className="button ghost small" onClick={() => onAsk(view.agentId, `About the dashboard "${view.title}": `)} title={`Ask ${author} to change it`}>
            <Icon name="chat" size={16} />
            <span>Ask {author}</span>
          </button>
          {confirming ? (
            <span className="dashboard-confirm" role="group" aria-label="Remove this dashboard?">
              <button type="button" className="button small danger" onClick={remove}>
                Remove it
              </button>
              <button type="button" className="button ghost small" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="button ghost small" onClick={() => setConfirming(true)} title="Remove this dashboard">
              <Icon name="trash" size={16} />
              <span>Remove</span>
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ViewFrame key={drawn} view={view} items={props.items} actions={actions} askTarget={`${author}'s chat`} />
    </article>
  );
}
