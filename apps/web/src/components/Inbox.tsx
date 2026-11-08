import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Agent, Item, Responsibility, Urgency } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { closedItems, groupOpenItems } from "../lib/inbox.ts";
import { formatAgo, formatDateTime, URGENCY_LABELS } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";

// The items board (DESIGN.md › Staff and work model: Item). New and open findings by
// responsibility, most pressing first. Item text comes from sources, so it renders as plain text.

interface InboxProps {
  items: Item[];
  responsibilities: Responsibility[];
  agents: Agent[];
  now: number;
  /** A responsibility to scroll to and highlight, such as from a pod sign. */
  focus: string | null;
  onDismiss(itemId: number, note?: string): Promise<void>;
  onResolve(itemId: number, note?: string): Promise<void>;
  onSelectAgent(agentId: string): void;
}

const URGENCIES: Urgency[] = ["urgent", "today", "this_week", "fyi"];

export function Inbox({ items, responsibilities, agents, now, focus, onDismiss, onResolve, onSelectAgent }: InboxProps) {
  const [filter, setFilter] = useState<Urgency | "all">("all");
  const groups = useMemo(() => groupOpenItems(items, responsibilities), [items, responsibilities]);
  const closed = useMemo(() => closedItems(items).slice(0, 30), [items]);
  const counts = useMemo(() => {
    const result: Record<Urgency, number> = { urgent: 0, today: 0, this_week: 0, fyi: 0 };
    for (const group of groups) for (const item of group.items) result[item.urgency]++;
    return result;
  }, [groups]);
  const visible = groups
    .map((group) => ({ ...group, items: filter === "all" ? group.items : group.items.filter((item) => item.urgency === filter) }))
    .filter((group) => group.items.length > 0);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    const target = boardRef.current?.querySelector<HTMLElement>(`[data-responsibility="${CSS.escape(focus)}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [focus]);

  return (
    <section className="view inbox-view" aria-labelledby="inbox-title">
      <header className="view-head">
        <div>
          <h1 id="inbox-title">Inbox</h1>
          <p className="muted">
            {total === 0 ? "Nothing needs you right now." : `${total} open item${total === 1 ? "" : "s"} across ${groups.length} responsibilit${groups.length === 1 ? "y" : "ies"}.`}
          </p>
        </div>
        <div className="filter-chips" role="group" aria-label="Filter by urgency">
          <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="chip-count">{total}</span>
          </button>
          {URGENCIES.map((urgency) => (
            <button key={urgency} type="button" className={`chip urgency-${urgency}`} aria-pressed={filter === urgency} onClick={() => setFilter(urgency)} disabled={counts[urgency] === 0 && filter !== urgency}>
              {URGENCY_LABELS[urgency]} <span className="chip-count">{counts[urgency]}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="board" ref={boardRef}>
        {visible.length === 0 && (
          <div className="empty-state">
            <Icon name="check" size={36} />
            <p>{total === 0 ? "All clear. Your staff will post here when something needs you." : "Nothing at this urgency."}</p>
          </div>
        )}
        {visible.map((group) => {
          const owner = agents.find((agent) => agent.id === group.responsibility?.ownerId);
          return (
            <section
              key={group.responsibilityId}
              className={`board-column${focus === group.responsibilityId ? " focused" : ""}`}
              data-responsibility={group.responsibilityId}
              tabIndex={-1}
              aria-label={group.responsibility?.title ?? "Responsibility"}
            >
              <header className="column-head">
                {owner && (
                  <button type="button" className="column-owner" onClick={() => onSelectAgent(owner.id)} title={`Open ${owner.name}'s profile`}>
                    <Portrait look={lookFor(owner.avatar)} size={34} animated={false} />
                    <span className="visually-hidden">{owner.name}</span>
                  </button>
                )}
                <div>
                  <h2>{group.responsibility?.title ?? "Unknown responsibility"}</h2>
                  {owner && <p className="muted small">{owner.name}</p>}
                </div>
                <span className="count-badge">{group.items.length}</span>
              </header>
              <ul className="item-list">
                {group.items.map((item) => (
                  <ItemCard key={item.id} item={item} now={now} onDismiss={onDismiss} onResolve={onResolve} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {closed.length > 0 && (
        <details className="closed-items">
          <summary>
            Recently closed <span className="chip-count">{closed.length}</span>
          </summary>
          <ul className="item-list closed">
            {closed.map((item) => (
              <li key={item.id} className={`item-card state-${item.state}`}>
                <p className="item-title">
                  <span className={`pill state-${item.state}`}>{item.state === "resolved" ? "Resolved" : "Dismissed"}</span> {item.title}
                </p>
                {item.resolution && <p className="small">{item.resolution}</p>}
                <p className="tiny muted">
                  {responsibilities.find((r) => r.id === item.responsibilityId)?.title ?? ""} · {formatAgo(item.updatedAt, now)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** How closing an item asks for its note: how it was resolved, or why it was dismissed. */
const CLOSING = {
  resolved: { question: "How was it resolved?", placeholder: "Moved the review to 11:00", button: "Resolve", busy: "Resolving…" },
  dismissed: { question: "Why dismiss it?", placeholder: "Not mine to act on", button: "Dismiss", busy: "Dismissing…" },
} as const;

function ItemCard({
  item,
  now,
  onDismiss,
  onResolve,
}: {
  item: Item;
  now: number;
  onDismiss(id: number, note?: string): Promise<void>;
  onResolve(id: number, note?: string): Promise<void>;
}) {
  const [closing, setClosing] = useState<keyof typeof CLOSING | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const close = closing === "dismissed" ? onDismiss : onResolve;
    void act(() => close(item.id, note.trim() || undefined));
  };

  return (
    <li className={`item-card urgency-${item.urgency} state-${item.state}`}>
      <div className="item-top">
        <span className={`urgency-chip urgency-${item.urgency}`}>{URGENCY_LABELS[item.urgency]}</span>
        {item.state === "new" && <span className="pill new-pill">New</span>}
        <time className="tiny muted" dateTime={item.firstSeenAt} title={`First seen ${formatDateTime(item.firstSeenAt)}`}>
          {formatAgo(item.firstSeenAt, now)}
        </time>
      </div>
      <p className="item-title">{item.title}</p>
      {item.detail && <p className="item-detail">{item.detail}</p>}
      {closing ? (
        <form className="resolve-form" onSubmit={submit}>
          <label htmlFor={noteId} className="small">
            {CLOSING[closing].question} <span className="muted">(optional)</span>
          </label>
          <input
            id={noteId}
            type="text"
            value={note}
            maxLength={500}
            placeholder={CLOSING[closing].placeholder}
            onChange={(event) => setNote(event.target.value)}
            autoFocus
          />
          {closing === "dismissed" && <p className="tiny muted">The staff review reads your reasons.</p>}
          <div className="button-row">
            <button type="submit" className={`button small ${closing === "resolved" ? "primary" : ""}`} disabled={busy}>
              {busy ? CLOSING[closing].busy : CLOSING[closing].button}
            </button>
            <button type="button" className="button ghost small" onClick={() => setClosing(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="button-row">
          <button type="button" className="button small" onClick={() => setClosing("resolved")} disabled={busy}>
            <Icon name="check" size={14} /> Resolve
          </button>
          <button type="button" className="button ghost small" onClick={() => setClosing("dismissed")} disabled={busy}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
