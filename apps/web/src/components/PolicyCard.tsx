import { useState } from "react";
import type { PolicyVersion } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatDateTime } from "../format.ts";
import { diffLines } from "../lib/policy.ts";
import { Icon } from "./Icon.tsx";

// The approval card for a change to the office policy that the Chief of Staff proposed (DESIGN.md ›
// Memory and notes). It shows the change line by line; nothing applies until the operator approves.

const STATUS_LABELS: Record<PolicyVersion["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

interface PolicyCardProps {
  policy: PolicyVersion | undefined;
  /** The chat message that carried the card. */
  intro: string;
  /** The text the proposal changes, or null when that version isn't loaded. */
  base: string | null;
  authorName: string;
  onApprove(): Promise<void>;
  onDecline(): Promise<void>;
}

export function PolicyCard({ policy, intro, base, authorName, onApprove, onDecline }: PolicyCardProps) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!policy) {
    return (
      <div className="card policy-card">
        <p>{intro}</p>
        <p className="muted small">This proposal is no longer on file.</p>
      </div>
    );
  }

  const decide = async (which: "approve" | "decline") => {
    setBusy(which);
    setError(null);
    try {
      await (which === "approve" ? onApprove() : onDecline());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`card policy-card status-${policy.status}`} aria-label="Proposed office policy">
      <header className="policy-card-head">
        <Icon name="policy" size={18} />
        <p className="eyebrow">Office policy</p>
        <span className={`pill policy-status-${policy.status}`}>{STATUS_LABELS[policy.status]}</span>
      </header>
      {policy.reason && <p>{policy.reason}</p>}
      {policy.fromSourceData && policy.status === "pending" && (
        <p className="callout warn">
          <Icon name="warning" size={16} /> {authorName} wrote this in a chat that had taken in data from your sources or the web. Check that every rule is one you asked for.
        </p>
      )}
      {base === null ? (
        <>
          <p className="muted small">The whole proposed policy:</p>
          <PolicyDiff before="" after={policy.body} />
        </>
      ) : (
        <PolicyDiff before={base} after={policy.body} />
      )}
      {policy.status === "pending" ? (
        <div className="button-row">
          <button type="button" className="button primary" disabled={busy !== null} onClick={() => void decide("approve")}>
            <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button type="button" className="button ghost" disabled={busy !== null} onClick={() => void decide("decline")}>
            {busy === "decline" ? "Declining…" : "Decline"}
          </button>
        </div>
      ) : (
        <p className="muted small">
          {STATUS_LABELS[policy.status]}
          {policy.decidedAt && ` ${formatDateTime(policy.decidedAt)}`}
          {policy.outcome && `: ${policy.outcome}`}
        </p>
      )}
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** A change shown line by line: removed lines struck through, added ones marked. */
export function PolicyDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  if (!lines.length) return <p className="muted small">An empty policy.</p>;
  return (
    <ol className="policy-diff">
      {lines.map((line, index) => (
        <li key={index} className={`diff-${line.kind}`}>
          <span className="diff-mark" aria-hidden="true">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </span>
          {line.kind !== "same" && <span className="visually-hidden">{line.kind === "added" ? "Added: " : "Removed: "}</span>}
          <span className="diff-text">{line.text || " "}</span>
        </li>
      ))}
    </ol>
  );
}
