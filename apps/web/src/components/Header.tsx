import type { RuntimeStatus } from "@aihub/shared";
import type { ConnectionStatus } from "../state.ts";

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
};

interface HeaderProps {
  runtime: RuntimeStatus | null;
  connection: ConnectionStatus;
  error: string | null;
}

export function Header({ runtime, connection, error }: HeaderProps) {
  return (
    <header className="topbar">
      <h1 className="brand">AiHub</h1>
      <div className="topbar-status">
        <Runtime runtime={runtime} />
        <p className={`status connection-${connection}`} role="status" title={error ?? undefined}>
          <span className="dot" aria-hidden="true" />
          <span className="visually-hidden">Event stream: </span>
          {CONNECTION_LABELS[connection]}
        </p>
      </div>
    </header>
  );
}

function Runtime({ runtime }: { runtime: RuntimeStatus | null }) {
  if (!runtime) {
    return (
      <p className="status runtime-unknown">
        <span className="dot" aria-hidden="true" />
        Checking the Codex sign-in…
      </p>
    );
  }
  if (runtime.signedIn) {
    return (
      <p className="status runtime-signed-in" title={runtime.detail}>
        <span className="dot" aria-hidden="true" />
        Signed in <span className="status-detail">{runtime.detail}</span>
      </p>
    );
  }
  return (
    <p className="status runtime-signed-out" title={runtime.detail}>
      <span className="dot" aria-hidden="true" />
      Not signed in. Run <code>npm run codex -- login</code>
      {runtime.detail && <span className="status-detail">{runtime.detail}</span>}
    </p>
  );
}
