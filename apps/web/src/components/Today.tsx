import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Agent, Briefing, BriefingItem, BriefingSectionRecord, Item, Responsibility, Routine, View } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatAgo, formatClock, formatDateTime, formatLongDate, isSameDay, URGENCY_LABELS } from "../format.ts";
import { lookFor } from "../lib/avatar.ts";
import { closedItems } from "../lib/inbox.ts";
import { needsLine, SECTION_STATUS_LABELS, sectionAsks, sectionsInOrder, toldState, type Decision } from "../lib/today.ts";
import { ViewFrame, type ViewActions } from "../views/LazyViewFrame.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Portrait } from "./office/Figure.tsx";

// The Today page (DESIGN.md › Layout): what needs the operator first, then the latest briefing by
// supervisor. Item and report text comes from sources, so it renders as plain text; only the Chief
// of Staff's overview is markdown.

interface TodayProps {
  items: Item[];
  /** Items that wait for the operator, most pressing first. */
  waiting: Item[];
  decisions: Decision[];
  responsibilities: Responsibility[];
  agents: Agent[];
  chief: Agent | null;
  briefing: Briefing | null;
  /** Views under the briefing's message. */
  views: View[];
  routines: Routine[];
  now: number;
  /** A responsibility to scroll to and highlight, such as from a pod sign. */
  focus: string | null;
  nameOf(agentId: string): string;
  onDismiss(itemId: number, note?: string): Promise<void>;
  onResolve(itemId: number, note?: string): Promise<void>;
  /** Opens a staff member's chat with a message in the box, unsent. */
  onDiscuss(agentId: string, text: string): void;
  onOpenDecision(decision: Decision): void;
  onSelectAgent(agentId: string): void;
}

const DECISION_ICONS: Record<Decision["kind"], IconName> = {
  meeting: "team",
  proposal: "user",
  staff_change: "team",
  policy: "policy",
  service: "plug",
};

export function Today(props: TodayProps) {
  const { items, waiting, decisions, briefing, now, focus } = props;
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const closed = useMemo(() => closedItems(items).slice(0, 30), [items]);
  const sections = useMemo(() => (briefing ? sectionsInOrder(briefing.sections, byId) : []), [briefing, byId]);
  const pageRef = useRef<HTMLElement>(null);
  const today = new Date(now);
  const fresh = briefing ? isSameDay(briefing.deliveredAt, today) : false;
  const asked = fresh ? "today's briefing" : "the briefing";

  // A pod's sign opens the page at its responsibility: its waiting items, or else its section.
  useEffect(() => {
    if (!focus) return;
    const target = pageRef.current?.querySelector<HTMLElement>(`[data-responsibility="${CSS.escape(focus)}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [focus]);

  const ownerOf = (responsibilityId: string) => props.responsibilities.find((responsibility) => responsibility.id === responsibilityId);
  const nextBriefing = props.routines.find((routine) => routine.kind === "briefing" && !routine.paused)?.nextRunAt ?? null;
  const total = waiting.length + decisions.length;

  return (
    <section className="view today-view" aria-labelledby="today-title" ref={pageRef}>
      <header className="view-head">
        <div>
          <p className="eyebrow">{formatLongDate(today.toISOString())}</p>
          <h1 id="today-title">Today</h1>
          <p className="muted">{needsLine(total)}</p>
        </div>
      </header>

      <section className="today-block" aria-labelledby="needs-title">
        <h2 id="needs-title" className="today-heading">
          Needs you {total > 0 && <span className="count-badge tone-open">{total}</span>}
        </h2>
        {total === 0 ? (
          <div className="empty-state compact">
            <Icon name="check" size={28} />
            <p>All clear. Your staff will put things here when something needs you.</p>
          </div>
        ) : (
          <>
            {decisions.length > 0 && (
              <ul className="today-decisions">
                {decisions.map((decision) => (
                  <li key={decision.key}>
                    <button type="button" className="card today-decision" onClick={() => props.onOpenDecision(decision)}>
                      <Icon name={DECISION_ICONS[decision.kind]} size={18} />
                      <span className="today-decision-title">{decision.title}</span>
                      <span className="tiny muted">{formatAgo(decision.createdAt, now)}</span>
                      <Icon name="chevron" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {waiting.length > 0 && (
              <ul className="item-list today-items">
                {waiting.map((item) => {
                  const responsibility = ownerOf(item.responsibilityId);
                  const ownerId = responsibility?.ownerId ?? null;
                  return (
                    <ItemCard
                      key={item.id}
                      item={item}
                      now={now}
                      focused={focus === item.responsibilityId}
                      from={responsibility ? `${responsibility.title}${ownerId ? ` · ${props.nameOf(ownerId)}` : ""}` : null}
                      onDiscuss={ownerId ? () => props.onDiscuss(ownerId, `About "${item.title}": `) : null}
                      onDismiss={props.onDismiss}
                      onResolve={props.onResolve}
                    />
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="today-block" aria-labelledby="briefing-title">
        <h2 id="briefing-title" className="today-heading">
          Morning briefing
          {briefing && (
            <span className="tiny muted today-heading-note">
              {fresh ? `Delivered ${formatClock(briefing.deliveredAt)}` : `The latest, from ${formatLongDate(briefing.deliveredAt)}`}
            </span>
          )}
        </h2>
        {!fresh && (
          <p className="muted small">
            {briefing ? "No briefing yet today." : "No briefing here yet."}
            {nextBriefing && ` The next one is due ${isSameDay(nextBriefing, today) ? "" : `${formatLongDate(nextBriefing)} `}at ${formatClock(nextBriefing)}.`}
          </p>
        )}
        {briefing && (
          <>
            <div className="today-overview">
              {props.chief && <Portrait look={lookFor(props.chief.avatar)} size={36} animated={false} />}
              <div>
                <p className="eyebrow">{props.chief?.name ?? "The Chief of Staff"}</p>
                <Markdown source={briefing.overview} className="today-overview-text" />
              </div>
            </div>
            <div className="today-sections">
              {sections.map((section) => (
                <SectionCard
                  key={`${section.agentId}:${section.heading}`}
                  section={section}
                  owner={props.agents.find((agent) => agent.id === section.agentId) ?? null}
                  name={props.nameOf(section.agentId)}
                  asks={sectionAsks(section, byId)}
                  byId={byId}
                  items={items}
                  views={props.views.filter((view) => section.runId !== null && view.runId === section.runId)}
                  asked={asked}
                  focused={focus !== null && focus === section.responsibilityId && !waiting.some((item) => item.responsibilityId === focus)}
                  onDiscuss={props.onDiscuss}
                  onResolve={props.onResolve}
                  onDismiss={props.onDismiss}
                  onSelectAgent={props.onSelectAgent}
                />
              ))}
            </div>
          </>
        )}
      </section>

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
                  {ownerOf(item.responsibilityId)?.title ?? ""} · {formatAgo(item.updatedAt, now)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

interface SectionCardProps {
  section: BriefingSectionRecord;
  owner: Agent | null;
  name: string;
  asks: number;
  byId: ReadonlyMap<number, Item>;
  items: Item[];
  views: View[];
  /** "today's briefing", or "the briefing" for an older one. */
  asked: string;
  focused: boolean;
  onDiscuss(agentId: string, text: string): void;
  onResolve(itemId: number, note?: string): Promise<void>;
  onDismiss(itemId: number): Promise<void>;
  onSelectAgent(agentId: string): void;
}

function SectionCard({ section, owner, name, asks, byId, items, views, asked, focused, onDiscuss, onResolve, onDismiss, onSelectAgent }: SectionCardProps) {
  const discuss = (text: string) => onDiscuss(section.agentId, text);
  const actions = useMemo<ViewActions>(() => ({ ask: (text) => onDiscuss(section.agentId, text), resolve: onResolve, dismiss: onDismiss }), [section.agentId, onDiscuss, onResolve, onDismiss]);
  const quiet = section.status === "nothing_new" && !section.fresh.length && !section.carried.length && !section.resolved.length && !section.warning;
  return (
    <article
      className={`card today-section status-${section.status}${focused ? " focused" : ""}${quiet ? " quiet" : ""}`}
      data-responsibility={section.responsibilityId ?? undefined}
      tabIndex={-1}
      aria-labelledby={`section-${section.agentId}`}
    >
      <header className="today-section-head">
        {owner ? (
          <button type="button" className="column-owner" onClick={() => onSelectAgent(owner.id)} title={`Open ${owner.name}'s profile`}>
            <Portrait look={lookFor(owner.avatar)} size={34} animated={false} />
            <span className="visually-hidden">{owner.name}</span>
          </button>
        ) : (
          <span className="today-section-gone" aria-hidden="true">
            <Icon name="user" size={18} />
          </span>
        )}
        <div className="today-section-title">
          <h3 id={`section-${section.agentId}`}>{section.heading}</h3>
          <p className="muted small">
            {name} · {section.source}
          </p>
        </div>
        {asks > 0 ? (
          <span className="pill today-asks">{asks} for you</span>
        ) : (
          <span className={`pill section-status-${section.status}`}>{SECTION_STATUS_LABELS[section.status]}</span>
        )}
      </header>

      {section.summary && <p className="today-summary">{section.summary}</p>}
      {quiet && <p className="muted small">Checked; nothing new since the last briefing.</p>}
      {section.reason && (
        <p className="callout warn">
          <Icon name="warning" size={16} />
          <span>
            {section.status === "missing" ? "This section is missing: " : "The source couldn't be read: "}
            {section.reason}
          </span>
        </p>
      )}
      {section.warning && (
        <p className="callout warn">
          <Icon name="warning" size={16} />
          <span>{section.warning}</span>
        </p>
      )}

      {section.decisions.length > 0 && (
        <div className="today-part">
          <h4 className="eyebrow">Questions for you</h4>
          <ul className="today-questions">
            {section.decisions.map((question) => (
              <li key={question}>
                <span>{question}</span>
                <button type="button" className="button ghost small" onClick={() => discuss(`On your question "${question}": `)}>
                  <Icon name="chat" size={14} /> Answer
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {section.fresh.length > 0 && (
        <div className="today-part">
          <h4 className="eyebrow">New</h4>
          <ul className="today-told">
            {section.fresh.map((told, index) => (
              <ToldItem key={told.id ?? `unkept-${index}`} told={told} byId={byId} onDiscuss={() => discuss(`About "${told.title}" from ${asked}: `)} />
            ))}
          </ul>
        </div>
      )}
      {section.carried.length > 0 && (
        // Told before and listed under Needs you, so here they fold away.
        <details className="today-part today-carried">
          <summary>
            <Icon name="chevron" size={14} />
            <span className="eyebrow">Still open from earlier</span> <span className="chip-count">{section.carried.length}</span>
            <span className="small muted today-carried-titles">{section.carried.map((told) => told.title).join(" · ")}</span>
          </summary>
          <ul className="today-told compact">
            {section.carried.map((told, index) => (
              <ToldItem key={told.id ?? `carried-${index}`} told={told} byId={byId} onDiscuss={() => discuss(`About "${told.title}": `)} />
            ))}
          </ul>
        </details>
      )}
      {section.resolved.length > 0 && (
        <p className="small muted today-resolved">
          <Icon name="check" size={14} /> Resolved since the last briefing: {section.resolved.map((told) => `${told.title}${told.resolution ? ` (${told.resolution})` : ""}`).join("; ")}
        </p>
      )}

      {views.map((view) => (
        <section key={view.id} className="message-view" aria-label={view.title}>
          <ViewFrame view={view} items={items} actions={actions} askTarget={`${name}'s chat`} />
        </section>
      ))}

      <div className="button-row today-section-actions">
        <button type="button" className="button ghost small" onClick={() => discuss(`About your section of ${asked}: `)} title={`Discuss this section with ${name}`}>
          <Icon name="chat" size={14} /> Discuss with {name}
        </button>
      </div>
    </article>
  );
}

/** An item as the briefing told it, with where it stands now. */
function ToldItem({ told, byId, onDiscuss }: { told: BriefingItem; byId: ReadonlyMap<number, Item>; onDiscuss(): void }) {
  const state = toldState(told, byId);
  const link = (told.id !== null ? byId.get(told.id)?.link : null) ?? told.link;
  return (
    <li className={`today-told-item state-${state}`}>
      <span className={`urgency-chip urgency-${told.urgency}`}>{URGENCY_LABELS[told.urgency]}</span>
      <div className="today-told-text">
        <p className="item-title">
          {told.title}
          {state === "waiting" && <span className="pill new-pill">Needs you</span>}
          {(state === "resolved" || state === "dismissed") && <span className={`pill state-${state}`}>{state === "resolved" ? "Resolved" : "Dismissed"}</span>}
        </p>
        {told.detail && <p className="item-detail">{told.detail}</p>}
      </div>
      <span className="today-told-actions">
        {link && (
          <a className="button ghost small" href={link} target="_blank" rel="noreferrer noopener" title="Open where it came from">
            <Icon name="expand" size={14} /> Source
          </a>
        )}
        <button type="button" className="button ghost small" onClick={onDiscuss} title="Discuss it">
          <Icon name="chat" size={14} />
          <span className="visually-hidden">Discuss</span>
        </button>
      </span>
    </li>
  );
}

/** How closing an item asks for its note: how it was resolved, or why it was dismissed. */
const CLOSING = {
  resolved: { question: "How was it resolved?", placeholder: "Moved the review to 11:00", button: "Resolve", busy: "Resolving…" },
  dismissed: { question: "Why dismiss it?", placeholder: "Not mine to act on", button: "Dismiss", busy: "Dismissing…" },
} as const;

interface ItemCardProps {
  item: Item;
  now: number;
  focused: boolean;
  /** Its responsibility and supervisor, such as "Work schedule · Elin". */
  from: string | null;
  onDiscuss: (() => void) | null;
  onDismiss(id: number, note?: string): Promise<void>;
  onResolve(id: number, note?: string): Promise<void>;
}

function ItemCard({ item, now, focused, from, onDiscuss, onDismiss, onResolve }: ItemCardProps) {
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
    <li className={`item-card urgency-${item.urgency} state-${item.state}${focused ? " focused" : ""}`} data-responsibility={item.responsibilityId} tabIndex={-1}>
      <div className="item-top">
        <span className={`urgency-chip urgency-${item.urgency}`}>{URGENCY_LABELS[item.urgency]}</span>
        {item.state === "new" && <span className="pill new-pill">New</span>}
        {from && <span className="tiny muted item-from">{from}</span>}
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
          {item.link && (
            <a className="button ghost small" href={item.link} target="_blank" rel="noreferrer noopener">
              <Icon name="expand" size={14} /> Open source
            </a>
          )}
          {onDiscuss && (
            <button type="button" className="button ghost small" onClick={onDiscuss}>
              <Icon name="chat" size={14} /> Discuss
            </button>
          )}
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
