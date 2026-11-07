import { useEffect, useState } from "react";
import type { HealthResponse } from "@aihub/shared";

type DaemonStatus =
  | { kind: "loading" }
  | { kind: "up"; health: HealthResponse }
  | { kind: "down"; error: string };

export function App() {
  const [status, setStatus] = useState<DaemonStatus>({ kind: "loading" });

  useEffect(() => {
    // The daemon gives this page its token cookie first; every other API call needs it.
    fetch("/api/session")
      .then(() => fetch("/api/health"))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setStatus({ kind: "up", health: (await res.json()) as HealthResponse });
      })
      .catch((err: unknown) => setStatus({ kind: "down", error: String(err) }));
  }, []);

  return (
    <main>
      <h1>AiHub</h1>
      {status.kind === "loading" && <p>Connecting to the daemon…</p>}
      {status.kind === "up" && (
        <p>
          Daemon {status.health.version} is running, started{" "}
          {new Date(status.health.startedAt).toLocaleString("sv-SE")}.
        </p>
      )}
      {status.kind === "down" && <p>Daemon unreachable: {status.error}</p>}
    </main>
  );
}
