import type { OfficeStats, RuntimeStatus, SourceConnection } from "@aihub/shared";
import { daylightAt, formatHour, stockholmTime } from "../lib/daylight.ts";
import { CONNECTION_STATUS_LABELS } from "../format.ts";
import type { ConnectionStatus } from "../state.ts";
import { Icon } from "./Icon.tsx";

export type View = "office" | "inbox" | "notes";

interface HudProps {
  view: View;
  onView(view: View): void;
  office: OfficeStats | null;
  runtime: RuntimeStatus | null;
  connection: ConnectionStatus;
  error: string | null;
  sources: SourceConnection[];
  inbox: { open: number; urgent: number };
  unread: number;
  chatOpen: boolean;
  rosterOpen: boolean;
  theme: "dark" | "light";
  now: number;
  onToggleChat(): void;
  onToggleRoster(): void;
  onToggleTheme(): void;
}

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
};

export function Hud(props: HudProps) {
  const { view, onView, office, inbox, unread } = props;
  return (
    <header className="hud">
      <div className="hud-brand">
        <Logo />
        <span className="hud-name">AiHub</span>
      </div>

      <nav className="hud-tabs" aria-label="Views">
        <TabButton current={view === "office"} onClick={() => onView("office")} icon="office" label="Office" />
        <TabButton
          current={view === "inbox"}
          onClick={() => onView("inbox")}
          icon="inbox"
          label="Inbox"
          count={inbox.open}
          tone={inbox.urgent > 0 ? "urgent" : undefined}
          countLabel={`${inbox.open} open${inbox.urgent ? `, ${inbox.urgent} urgent` : ""}`}
        />
        <TabButton current={view === "notes"} onClick={() => onView("notes")} icon="notes" label="Notes" />
      </nav>

      <div className="hud-stats">
        <Energy office={office} />
        <Stat
          icon="team"
          label="Supervisors"
          value={office ? `${office.activeSupervisors}/${office.supervisorLimit}` : "–"}
          title="Active supervisors and the most the office allows"
        />
        <Stat
          icon="streak"
          label="Streak"
          value={office ? `${office.briefingStreak}` : "–"}
          suffix={office?.briefingStreak === 1 ? "day" : "days"}
          title="Weekdays in a row with a briefing delivered"
          hot={(office?.briefingStreak ?? 0) >= 3}
        />
      </div>

      <div className="hud-status">
        <Runtime runtime={props.runtime} />
        <Sources sources={props.sources} />
        <p className={`hud-chip connection-${props.connection}`} role="status" title={props.error ?? "Following the office's event stream"}>
          <span className="dot" aria-hidden="true" />
          <span className="visually-hidden">Event stream: </span>
          {CONNECTION_LABELS[props.connection]}
        </p>
        <Clock now={props.now} />
      </div>

      <div className="hud-actions">
        <button type="button" className="icon-button" aria-pressed={props.rosterOpen} onClick={props.onToggleRoster} title="Show the staff list">
          <Icon name="list" />
          <span className="visually-hidden">Staff list</span>
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={props.onToggleTheme}
          title={props.theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
        >
          <Icon name={props.theme === "dark" ? "sun" : "moon"} />
          <span className="visually-hidden">{props.theme === "dark" ? "Light theme" : "Dark theme"}</span>
        </button>
        <button type="button" className="chat-button" aria-pressed={props.chatOpen} onClick={props.onToggleChat}>
          <Icon name="chat" />
          <span>Chat</span>
          {unread > 0 && (
            <span className="count-badge" aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}

function TabButton(props: { current: boolean; onClick(): void; icon: "office" | "inbox" | "notes"; label: string; count?: number; countLabel?: string; tone?: "urgent" }) {
  return (
    <button type="button" className="hud-tab" aria-current={props.current ? "page" : undefined} onClick={props.onClick}>
      <Icon name={props.icon} />
      <span>{props.label}</span>
      {props.count !== undefined && props.count > 0 && (
        <span className={`count-badge${props.tone ? ` tone-${props.tone}` : ""}`} aria-label={props.countLabel}>
          {props.count}
        </span>
      )}
    </button>
  );
}

function Energy({ office }: { office: OfficeStats | null }) {
  if (!office) return <Stat icon="energy" label="Energy" value="–" title="The day's turn budget" />;
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

function Stat(props: { icon: "team" | "streak" | "energy"; label: string; value: string; suffix?: string; title: string; hot?: boolean }) {
  return (
    <div className={`hud-stat${props.hot ? " hot" : ""}`} title={props.title}>
      <Icon name={props.icon} />
      <span className="visually-hidden">{props.label}: </span>
      <span className="hud-stat-value">
        {props.value}
        {props.suffix && <span className="muted"> {props.suffix}</span>}
      </span>
    </div>
  );
}

function Runtime({ runtime }: { runtime: RuntimeStatus | null }) {
  if (!runtime) {
    return (
      <p className="hud-chip runtime-unknown" title="Checking the Codex sign-in">
        <span className="dot" aria-hidden="true" />
        Codex…
      </p>
    );
  }
  if (runtime.signedIn) {
    return (
      <p className="hud-chip runtime-ok" title={`Codex: signed in. ${runtime.detail}`}>
        <span className="dot" aria-hidden="true" />
        Codex
        <span className="visually-hidden"> signed in, {runtime.detail}</span>
      </p>
    );
  }
  return (
    <details className="hud-popover">
      <summary className="hud-chip runtime-bad">
        <span className="dot" aria-hidden="true" />
        Codex signed out
      </summary>
      <div className="popover-panel" role="note">
        <p>
          Staff can't work until Codex is signed in. Run <code>npm run codex -- login</code> in the AiHub folder.
        </p>
        {runtime.detail && <p className="muted">{runtime.detail}</p>}
      </div>
    </details>
  );
}

function Sources({ sources }: { sources: SourceConnection[] }) {
  const problems = sources.filter((source) => source.status !== "connected");
  if (problems.length === 0) return null;
  const failed = problems.some((source) => source.status === "failed");
  return (
    <details className="hud-popover">
      <summary className={`hud-chip ${failed ? "runtime-bad" : "runtime-warn"}`}>
        <Icon name="plug" />
        {problems.length} source{problems.length === 1 ? "" : "s"}
      </summary>
      <div className="popover-panel">
        <p className="popover-title">Connections that need attention</p>
        <ul className="plain-list">
          {problems.map((source) => (
            <li key={source.id}>
              <strong>{source.label}</strong> <span className={`pill status-${source.status}`}>{CONNECTION_STATUS_LABELS[source.status]}</span>
              <p className="muted small">{source.detail ?? (source.path ? source.path : "No file chosen yet.")}</p>
            </li>
          ))}
        </ul>
      </div>
    </details>
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

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="7" width="26" height="20" rx="5" fill="var(--accent)" />
      <rect x="7" y="11" width="7" height="6" rx="1.5" fill="var(--on-accent)" opacity="0.9" />
      <rect x="18" y="11" width="7" height="6" rx="1.5" fill="var(--on-accent)" opacity="0.9" />
      <rect x="13" y="19" width="6" height="8" rx="1.5" fill="var(--on-accent)" />
      <path d="M8 7 L16 2 L24 7" stroke="var(--accent)" strokeWidth="2.4" fill="none" strokeLinejoin="round" />
    </svg>
  );
}
