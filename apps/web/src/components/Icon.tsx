// Line icons, drawn for AiHub on a 24 × 24 grid. Decorative: pair each with visible or hidden text.

export type IconName =
  | "office"
  | "inbox"
  | "notes"
  | "team"
  | "streak"
  | "energy"
  | "list"
  | "sun"
  | "moon"
  | "chat"
  | "plug"
  | "close"
  | "edit"
  | "check"
  | "graph"
  | "folder"
  | "file"
  | "journal"
  | "send"
  | "play"
  | "warning"
  | "lock"
  | "back"
  | "chevron"
  | "activity"
  | "user";

const PATHS: Record<IconName, string> = {
  office: "M3 21V8l9-5 9 5v13M3 21h18M9 21v-6h6v6M7 10h2M15 10h2",
  inbox: "M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1.5 3h5L16 13h5",
  notes: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5",
  team: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 20a5.5 5.5 0 0 1 11 0M16.5 11a2.5 2.5 0 1 0 0-5M17 14.5a5 5 0 0 1 4.5 5.5",
  streak: "M12 21c-4 0-6.5-2.8-6.5-6.2 0-3.2 2.3-5 3.6-7.3.5 1.6 1.4 2.6 2.4 3C12 7.7 13.2 5 15.6 3c-.4 3 1 4.6 2.2 6.6.8 1.3 1.2 2.8 1.2 4.2C19 18 16 21 12 21z",
  energy: "M13 2L4.5 13.5H11L10 22l8.5-11.5H12z",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1.5v2M12 20.5v2M3.5 12h-2M22.5 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4",
  moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z",
  chat: "M4 5h16v11H9l-5 4z M8 9.5h8M8 12.5h5",
  plug: "M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5",
  close: "M6 6l12 12M18 6L6 18",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  check: "M4.5 12.5l5 5 10-11",
  graph: "M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M18 7m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M12 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8.2 7.2l7.4-.2M7.3 8.2l3.6 7.6M16.8 9.2l-3.6 6.6",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  file: "M6 3h9l4 4v14H6zM15 3v4h4",
  journal: "M5 4h11a3 3 0 0 1 3 3v14H8a3 3 0 0 1-3-3zM5 18a3 3 0 0 1 3-3h11M9 8h6",
  send: "M3 11.5L21 3l-6.5 18-3-7.5zM11.5 13.5L21 3",
  play: "M7 4.5v15l12.5-7.5z",
  warning: "M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5v.01",
  lock: "M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  back: "M15 5l-7 7 7 7",
  chevron: "M9 6l6 6-6 6",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const filled = name === "energy" || name === "streak" || name === "play";
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 1.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
