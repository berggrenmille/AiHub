import { Icon, type IconName } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";

// The office's navigation, down the left edge: the pages first, then the panels that open beside
// them, and the operator's own settings at the bottom.

export type Page = "office" | "today" | "chats" | "notes" | "dashboards";
export type Theme = "dark" | "light";

interface RailProps {
  page: Page;
  onPage(page: Page): void;
  /** What waits for the operator on the Today page: items and decisions, and whether any item is urgent. */
  today: { waiting: number; urgent: boolean };
  /** Staff messages the operator hasn't seen, across every chat. */
  unread: number;
  /** Open and waiting assignments. */
  assignments: number;
  assignmentsOpen: boolean;
  onToggleAssignments(): void;
  /** Grants in force that break the data boundary. */
  unsafeCount: number;
  accessOpen: boolean;
  onToggleAccess(): void;
  /** A change to the office policy waits for the operator. */
  policyPending: boolean;
  policyOpen: boolean;
  onTogglePolicy(): void;
  theme: Theme;
  onTheme(theme: Theme): void;
}

export function Rail(props: RailProps) {
  const { page, onPage, today } = props;
  const link = (target: Page, icon: IconName, label: string, badge?: Badge) => (
    <li>
      <button type="button" className="rail-item" aria-current={page === target ? "page" : undefined} onClick={() => onPage(target)} title={label}>
        <Icon name={icon} />
        <span className="rail-label">{label}</span>
        {badge && <CountBadge {...badge} />}
      </button>
    </li>
  );
  const panel = (open: boolean, onToggle: () => void, icon: IconName, label: string, title: string, badge?: Badge) => (
    <li>
      <button type="button" className="rail-item" aria-pressed={open} onClick={onToggle} title={title}>
        <Icon name={icon} />
        <span className="rail-label">{label}</span>
        {badge && <CountBadge {...badge} />}
      </button>
    </li>
  );

  return (
    <nav className="rail" aria-label="AiHub">
      <div className="rail-brand">
        <Logo />
        <span className="rail-label">AiHub</span>
      </div>
      <ul className="rail-group">
        {link("office", "office", "Office")}
        {link("today", "sun", "Today", { count: today.waiting, tone: today.urgent ? "urgent" : "open", label: `${today.waiting} need${today.waiting === 1 ? "s" : ""} you${today.urgent ? ", some urgent" : ""}` })}
        {link("chats", "chats", "Chats", { count: props.unread, tone: "accent", label: `${props.unread} unread` })}
        {panel(props.assignmentsOpen, props.onToggleAssignments, "task", "Assignments", "Assignments: questions and tasks between staff", {
          count: props.assignments,
          tone: "open",
          label: `${props.assignments} open`,
        })}
        {link("notes", "notes", "Notes")}
        {link("dashboards", "dashboard", "Dashboards")}
      </ul>
      <ul className="rail-group rail-bottom">
        {panel(props.accessOpen, props.onToggleAccess, "key", "Access", "Access: what staff can reach, and who holds it", {
          count: props.unsafeCount,
          tone: "urgent",
          label: `${props.unsafeCount} unsafe grant${props.unsafeCount === 1 ? "" : "s"}`,
        })}
        {panel(props.policyOpen, props.onTogglePolicy, "policy", "Policy", "The office policy: rules every staff member works under", {
          count: props.policyPending ? 1 : 0,
          tone: "open",
          label: "a proposed change waits for you",
        })}
        <li>
          <Popover
            className="rail-settings"
            summaryClass="rail-item"
            summary={
              <>
                <Icon name="settings" />
                <span className="rail-label">Settings</span>
              </>
            }
          >
            <div className="popover-panel rail-popover">
              <p className="popover-title">Settings</p>
              <fieldset className="theme-choice">
                <legend>Theme</legend>
                {(["dark", "light"] as const).map((theme) => (
                  <label key={theme}>
                    <input type="radio" name="theme" checked={props.theme === theme} onChange={() => props.onTheme(theme)} />
                    <Icon name={theme === "dark" ? "moon" : "sun"} size={16} />
                    {theme === "dark" ? "Dark" : "Light"}
                  </label>
                ))}
              </fieldset>
            </div>
          </Popover>
        </li>
      </ul>
    </nav>
  );
}

interface Badge {
  count: number;
  tone?: "urgent" | "open" | "accent";
  /** What the count means, for screen readers. */
  label: string;
}

function CountBadge({ count, tone, label }: Badge) {
  if (count <= 0) return null;
  return (
    <span className={`count-badge${tone ? ` tone-${tone}` : ""}`}>
      <span aria-hidden="true">{count}</span>
      <span className="visually-hidden">, {label}</span>
    </span>
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
