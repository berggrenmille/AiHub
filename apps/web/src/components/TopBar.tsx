import type { OfficeStats, RuntimeStatus, SourceConnection } from "@aihub/shared";
import { daylightAt, formatHour, stockholmTime } from "../lib/daylight.ts";
import { CONNECTION_STATUS_LABELS } from "../format.ts";
import type { ConnectionStatus } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";

// The bar over every page: the office's numbers on the Office page, then what the operator glances
// at anywhere: the day's energy, whether everything works, the time, and the chat.

interface TopBarProps {
  office: OfficeStats | null;
  /** On the Office page: the staff list's toggle, and the office's numbers. */
  floor: { rosterOpen: boolean; onToggleRoster(): void } | null;
  runtime: RuntimeStatus | null;
  connection: ConnectionStatus;
  error: string | null;
  sources: SourceConnection[];
  now: number;
  chat: { name: string; open: boolean; unread: number; onToggle(): void };
}

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
};

export function TopBar(props: TopBarProps) {
  const { office, floor, chat } = props;
  return (
    <header className="topbar">
      <div className="topbar-context">
        {floor && (
          <>
            <button type="button" className="icon-button" aria-pressed={floor.rosterOpen} onClick={floor.onToggleRoster} title="Show the staff list">
              <Icon name="list" />
              <span className="visually-hidden">Staff list</span>
            </button>
            {office && (
              <p className="topbar-stats">
                <span title="Active supervisors and the most the office allows">
                  <Icon name="team" size={16} />
                  {office.activeSupervisors} of {office.supervisorLimit} supervisors
                </span>
                <span className={office.briefingStreak >= 3 ? "hot" : undefined} title="Days in a row with a briefing delivered. A weekend without one doesn't break it.">
                  <Icon name="streak" size={16} />
                  {office.briefingStreak}-day briefing streak
                </span>
              </p>
            )}
          </>
        )}
      </div>
      <div className="topbar-status">
        <Energy office={office} />
        <Health runtime={props.runtime} connection={props.connection} error={props.error} sources={props.sources} />
        <Clock now={props.now} />
      </div>
      <button type="button" className="chat-button" aria-pressed={chat.open} onClick={chat.onToggle} title={`Chat with ${chat.name}`}>
        <Icon name="chat" />
        <span>Chat</span>
        {chat.unread > 0 && (
          <span className="count-badge" aria-label={`${chat.unread} unread`}>
            {chat.unread}
          </span>
        )}
      </button>
    </header>
  );
}

function Energy({ office }: { office: OfficeStats | null }) {
  if (!office) {
    return (
      <div className="hud-stat energy" title="The day's turn budget">
        <Icon name="energy" />
        <span className="visually-hidden">Energy: </span>–
      </div>
    );
  }
  const left = Math.max(0, office.dailyTurnLimit - office.turnsToday);
  const fraction = office.dailyTurnLimit > 0 ? left / office.dailyTurnLimit : 0;
  const tone = fraction <= 0.15 ? "low" : fraction <= 0.4 ? "mid" : "high";
  return (
    <div
      className={`hud-stat energy energy-${tone}`}
      title={`Energy is the day's turn budget: ${office.turnsToday} of ${office.dailyTurnLimit} turns used today, ${left} left. Background work waits for tomorrow when it runs out.`}
    >
      <Icon name="energy" />
      <span className="visually-hidden">Energy: </span>
      <span
        className="energy-bar"
        role="meter"
        aria-label="Turns left today"
        aria-valuemin={0}
        aria-valuemax={office.dailyTurnLimit}
        aria-valuenow={left}
        aria-valuetext={`${left} of ${office.dailyTurnLimit} turns left`}
      >
        <span className="energy-fill" style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="hud-stat-value">
        {left}
        <span className="muted">/{office.dailyTurnLimit}</span>
      </span>
    </div>
  );
}

interface Problem {
  tone: "bad" | "warn";
  label: string;
}

/** One chip for whether the office works: Codex's sign-in, the event stream, and the sources. */
function Health({ runtime, connection, error, sources }: { runtime: RuntimeStatus | null; connection: ConnectionStatus; error: string | null; sources: SourceConnection[] }) {
  const failing = sources.filter((source) => source.status !== "connected");
  const problems: Problem[] = [];
  if (runtime && !runtime.signedIn) problems.push({ tone: "bad", label: "Codex signed out" });
  if (connection !== "connected") problems.push({ tone: "warn", label: CONNECTION_LABELS[connection] });
  if (failing.length) problems.push({ tone: failing.some((source) => source.status === "failed") ? "bad" : "warn", label: `${failing.length} source${failing.length === 1 ? "" : "s"} need${failing.length === 1 ? "s" : ""} you` });
  const checking = runtime === null && problems.length === 0;
  const tone = problems.some((problem) => problem.tone === "bad") ? "runtime-bad" : problems.length ? "runtime-warn" : checking ? "runtime-unknown" : "runtime-ok";
  const label = problems[0]?.label ?? (checking ? "Checking…" : "All good");
  const more = problems.length > 1 ? ` +${problems.length - 1}` : "";

  return (
    <>
      <p className="visually-hidden" role="status">
        Office status: {problems.length ? problems.map((problem) => problem.label).join(", ") : label}
      </p>
      <Popover
        summaryClass={`hud-chip ${tone}`}
        summary={
          <>
            <span className="dot" aria-hidden="true" />
            {label}
            {more}
          </>
        }
      >
        <div className="popover-panel">
          <p className="popover-title">How the office is doing</p>
          <ul className="plain-list health-list">
            <li>
              <strong>Codex</strong>{" "}
              {runtime === null ? (
                <span className="muted">Checking the sign-in…</span>
              ) : runtime.signedIn ? (
                <span className="pill status-connected">Signed in</span>
              ) : (
                <span className="pill status-failed">Signed out</span>
              )}
              {runtime && !runtime.signedIn && (
                <p className="small">
                  Staff can't work until Codex is signed in. Run <code>npm run codex -- login</code> in the AiHub folder.
                </p>
              )}
              {runtime?.detail && <p className="muted small">{runtime.detail}</p>}
            </li>
            <li>
              <strong>This page</strong>{" "}
              <span className={`pill ${connection === "connected" ? "status-connected" : "status-pending"}`}>{connection === "connected" ? "Live" : CONNECTION_LABELS[connection]}</span>
              <p className="muted small">{error ?? (connection === "connected" ? "Following the office as it works." : "Catching up with the office.")}</p>
            </li>
            <li>
              <strong>Sources</strong>{" "}
              {failing.length === 0 ? (
                <span className="muted small">{sources.length ? `All ${sources.length} connected.` : "None yet."}</span>
              ) : (
                <ul className="plain-list">
                  {failing.map((source) => (
                    <li key={source.id}>
                      {source.label} <span className={`pill status-${source.status}`}>{CONNECTION_STATUS_LABELS[source.status]}</span>
                      <p className="muted small">{source.detail ?? (source.path ? source.path : "No file chosen yet.")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          </ul>
        </div>
      </Popover>
    </>
  );
}

function Clock({ now }: { now: number }) {
  const date = new Date(now);
  const daylight = daylightAt(date);
  const local = stockholmTime(date);
  const night = daylight.phase === "night" || daylight.phase === "dusk";
  const sun = daylight.sunrise !== null && daylight.sunset !== null ? `Sunrise ${formatHour(daylight.sunrise)}, sunset ${formatHour(daylight.sunset)}` : "";
  return (
    <p className={`hud-clock phase-${daylight.phase}`} title={`Stockholm time. ${sun}`}>
      <Icon name={night ? "moon" : "sun"} />
      <time>{formatHour(Math.floor(local.hour * 60) / 60)}</time>
    </p>
  );
}
