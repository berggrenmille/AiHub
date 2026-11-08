import { useState } from "react";
import type { Service } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatDateTime } from "../format.ts";
import { describeOperation, inUse, missingTicks, SERVICE_KIND_LABELS, SERVICE_STATUS_LABELS, sortedOperations } from "../lib/access.ts";
import { Icon } from "./Icon.tsx";
import { UnsafeGrants } from "./UnsafeGrants.tsx";

// A proposed service, in the Chief of Staff's chat (DESIGN.md › Connectors and capabilities): what it
// reaches and how. The operator approves it here, then connects the app at ChatGPT or signs in to the
// MCP server, and AiHub checks it. Signing in happens at the service: AiHub never sees a password.

interface ServiceCardProps {
  service: Service | undefined;
  /** The chat message that carried the card. */
  intro: string;
  onApprove(unsafe: string[]): Promise<void>;
  onDecline(): Promise<void>;
  onSignIn(): Promise<string>;
  onRefresh(): Promise<void>;
}

export function ServiceCard({ service, intro, onApprove, onDecline, onSignIn, onRefresh }: ServiceCardProps) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!service) {
    return (
      <div className="card service-card">
        <p>{intro}</p>
        <p className="muted small">This service is no longer on file.</p>
      </div>
    );
  }

  const pending = service.status === "proposed";
  const unsafe = service.unsafe ? [service.unsafe] : [];
  const missing = missingTicks(unsafe, ticked);
  const run = async (kind: "approve" | "decline") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "approve") await onApprove([...ticked]);
      else await onDecline();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`card service-card status-${service.status}`} aria-label={`Proposal: add ${service.name}`}>
      <p className="proposal-intro">{intro}</p>
      <header className="proposal-head">
        <span className="service-badge" aria-hidden="true">
          <Icon name={service.kind === "local_mcp" ? "warning" : "plug"} size={28} />
        </span>
        <div>
          <p className="eyebrow">Add a service</p>
          <h3>{service.name}</h3>
          <p className="muted">{SERVICE_KIND_LABELS[service.kind]}</p>
        </div>
        <span className={`pill service-status status-${service.status}`}>{SERVICE_STATUS_LABELS[service.status]}</span>
      </header>

      <dl className="facts">
        <div>
          <dt>{service.kind === "local_mcp" ? "Runs" : service.kind === "app" ? "App" : "Address"}</dt>
          <dd className="connection-path">{service.where}</dd>
        </div>
        {service.account && (
          <div>
            <dt>Account</dt>
            <dd>{service.account}</dd>
          </div>
        )}
        <div>
          <dt>Operations</dt>
          <dd>
            <OperationList service={service} />
          </dd>
        </div>
        {service.reason && (
          <div>
            <dt>Why</dt>
            <dd>{service.reason}</dd>
          </div>
        )}
        <div>
          <dt>Who may use it</dt>
          <dd className="muted">Nobody yet. Each supervisor that uses it is a proposal of its own, with the operations it may call.</dd>
        </div>
      </dl>

      {pending ? (
        <form
          className="proposal-actions"
          onSubmit={(event) => {
            event.preventDefault();
            if (missing.length) setError(`Tick “${missing[0]!.what}” first.`);
            else void run("approve");
          }}
        >
          <UnsafeGrants grants={unsafe} ticked={ticked} disabled={busy !== null} onToggle={(key, on) => setTicked(toggled(ticked, key, on))} />
          {service.kind === "app" && !service.operations.length && service.connectUrl && (
            <p className="callout gate gate-info">
              <Icon name="plug" size={16} />
              <span>
                Connect it at ChatGPT first:{" "}
                <a href={service.connectUrl} target="_blank" rel="noreferrer">
                  open {service.where.replace(/, a ChatGPT app$/, "")} at ChatGPT
                </a>
                . Approving then checks it.
              </span>
            </p>
          )}
          {service.kind !== "app" && <p className="tiny muted">Once approved, you sign in to it from this card. Codex keeps the sign-in; AiHub never sees your password.</p>}
          <div className="button-row">
            <button type="submit" className="button primary" disabled={busy !== null || missing.length > 0} title={missing.length ? `Tick “${missing[0]!.what}” first` : undefined}>
              <Icon name="check" />
              {busy === "approve" ? "Approving…" : `Approve ${service.name}`}
            </button>
            <button type="button" className="button ghost" disabled={busy !== null} onClick={() => void run("decline")}>
              {busy === "decline" ? "Declining…" : "Decline"}
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <div className="proposal-outcome">
          {service.detail && service.status !== "connected" && <p className="small">{service.detail}</p>}
          {inUse(service) && <ServiceActions service={service} onSignIn={onSignIn} onRefresh={onRefresh} />}
          {service.checkedAt && <p className="tiny muted">Checked {formatDateTime(service.checkedAt)}</p>}
        </div>
      )}
    </article>
  );
}

/** A service's operations: how many, how many only read, and each with its label. */
export function OperationList({ service }: { service: Service }) {
  const { operations } = service;
  if (!operations.length) {
    return <span className="muted">{service.status === "proposed" ? "Listed once it is approved and signed in." : "None listed yet."}</span>;
  }
  const reads = operations.filter((operation) => operation.label === "reads").length;
  return (
    <details className="operation-list">
      <summary>
        {operations.length} operation{operations.length === 1 ? "" : "s"}, {reads} of them only read
      </summary>
      <ul>
        {sortedOperations(operations).map((operation) => (
          <li key={operation.name}>
            <code>{operation.name}</code>{" "}
            <span className={`pill tiny label-${operation.label}${operation.openWorld ? " open-world" : ""}`}>{describeOperation(operation)}</span>
            {operation.description && <span className="block tiny muted">{clip(operation.description, 160)}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Sign in, connect at ChatGPT, and check again, for a service in use. A sign-in opens the service's
 * own page in a new tab; Codex finishes it there, and the daemon checks the service once it has.
 */
export function ServiceActions({ service, onSignIn, onRefresh }: { service: Service; onSignIn(): Promise<string>; onRefresh(): Promise<void> }) {
  const [busy, setBusy] = useState<"sign-in" | "refresh" | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    // Opened now, while the click still counts, so the browser doesn't block it.
    const tab = window.open("", "_blank");
    setBusy("sign-in");
    setError(null);
    try {
      const url = await onSignIn();
      setSignInUrl(url);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      }
    } catch (failure) {
      tab?.close();
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      await onRefresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const canSignIn = service.kind !== "app" && service.status !== "connected";
  return (
    <div className="service-actions">
      <div className="button-row">
        {canSignIn && (
          <button type="button" className="button primary small" disabled={busy !== null} onClick={() => void signIn()}>
            <Icon name="lock" size={14} /> {busy === "sign-in" ? "Opening…" : service.status === "signed_out" ? "Sign in" : "Sign in again"}
          </button>
        )}
        {service.kind === "app" && service.status !== "connected" && service.connectUrl && (
          <a className="button small" href={service.connectUrl} target="_blank" rel="noreferrer">
            <Icon name="plug" size={14} /> Connect at ChatGPT
          </a>
        )}
        <button type="button" className="button ghost small" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === "refresh" ? "Checking…" : "Check again"}
        </button>
      </div>
      {signInUrl && service.status !== "connected" && (
        <p className="tiny muted">
          Finish signing in on the service's page.{" "}
          <a href={signInUrl} target="_blank" rel="noreferrer">
            Open it again
          </a>{" "}
          if no tab opened. AiHub checks the service once you're done.
        </p>
      )}
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The set with the key ticked or unticked. */
export function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
