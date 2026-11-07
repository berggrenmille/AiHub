import { useId, useState, type FormEvent } from "react";
import type { Proposal, ProposedSource } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { formatDateTime } from "../format.ts";
import { Portrait } from "./office/Figure.tsx";
import { Icon } from "./Icon.tsx";

// An approval card for a proposal in the Chief of Staff's chat (DESIGN.md › Recruitment and
// delegation): who would join, what they'd own, what they'd watch, and why.

interface ProposalCardProps {
  proposal: Proposal | undefined;
  /** The chat message that carried the card. */
  intro: string;
  onApprove(sourcePath?: string): Promise<void>;
  onDecline(): Promise<void>;
}

const READER_LABELS: Record<NonNullable<ProposedSource["reader"]>, string> = {
  markdown: "markdown notes",
  text: "text files",
  csv: "CSV files",
  json: "JSON files",
};

/** What the card says about a source, and what it asks the operator to pick. */
export function describeSource(source: ProposedSource): { kind: string; pick: string; placeholder: string } {
  if (source.kind === "folder") {
    const files = source.reader ? READER_LABELS[source.reader] : "files";
    return {
      kind: `folder of ${files}${source.pattern ? `, ${source.pattern}` : ""}`,
      pick: "path to the folder on this PC",
      placeholder: "C:\\Users\\you\\Documents\\Reading list",
    };
  }
  return { kind: "calendar file", pick: "path to the .ics file on this PC", placeholder: "C:\\Users\\you\\Documents\\calendar.ics" };
}

const STATUS_LABELS: Record<Proposal["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
};

export function ProposalCard({ proposal, intro, onApprove, onDecline }: ProposalCardProps) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathId = useId();

  if (!proposal) {
    return (
      <div className="card proposal-card">
        <p>{intro}</p>
        <p className="muted small">This proposal is no longer on file.</p>
      </div>
    );
  }

  const { profile, responsibility, source, reason } = proposal.payload;
  const pending = proposal.status === "pending";
  const pathNeeded = pending && source !== null;
  const trimmed = path.trim();
  const looksLikeIcs = /\.ics$/i.test(trimmed);
  const described = source ? describeSource(source) : null;

  const run = async (kind: "approve" | "decline") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "approve") await onApprove(source ? trimmed : undefined);
      else await onDecline();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pathNeeded && !trimmed) {
      setError(`Enter the path of the ${source.label.toLowerCase()} ${source.kind === "folder" ? "folder" : "file"} first.`);
      return;
    }
    void run("approve");
  };

  return (
    <article className={`card proposal-card status-${proposal.status}`} aria-label={`Proposal: recruit ${profile.name}`}>
      <p className="proposal-intro">{intro}</p>
      <header className="proposal-head">
        <Portrait look={lookFor(profile.name)} size={64} label={`How ${profile.name} might look`} />
        <div>
          <p className="eyebrow">Recruit a supervisor</p>
          <h3>{profile.name}</h3>
          <p className="muted">{profile.title}</p>
        </div>
        <span className={`pill proposal-status status-${proposal.status}`}>{STATUS_LABELS[proposal.status]}</span>
      </header>

      <dl className="facts">
        <div>
          <dt>Job</dt>
          <dd>{profile.description}</dd>
        </div>
        {profile.workingStyle && (
          <div>
            <dt>Working style</dt>
            <dd>{profile.workingStyle}</dd>
          </div>
        )}
        <div>
          <dt>Responsibility</dt>
          <dd>
            <strong>{responsibility.title}</strong>
            {responsibility.scope && <span className="block">{responsibility.scope}</span>}
            {responsibility.expiresAt && <span className="block muted">Ends {formatDateTime(responsibility.expiresAt)}</span>}
          </dd>
        </div>
        {responsibility.standingInstructions && (
          <div>
            <dt>Standing instructions</dt>
            <dd>{responsibility.standingInstructions}</dd>
          </div>
        )}
        <div>
          <dt>Source</dt>
          <dd>{source && described ? `${source.label} (${described.kind})` : "None needed"}</dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{reason}</dd>
        </div>
      </dl>

      {pending ? (
        <form className="proposal-actions" onSubmit={onSubmit}>
          {source && described && (
            <div className="field">
              <label htmlFor={pathId}>
                {source.label}: {described.pick}
              </label>
              <input
                id={pathId}
                type="text"
                value={path}
                spellCheck={false}
                autoComplete="off"
                placeholder={described.placeholder}
                onChange={(event) => setPath(event.target.value)}
              />
              {source.kind === "ics_file" && trimmed && !looksLikeIcs && <p className="hint warn">That doesn't end in .ics. AiHub reads calendar files.</p>}
            </div>
          )}
          <div className="button-row">
            <button type="submit" className="button primary" disabled={busy !== null}>
              <Icon name="check" />
              {busy === "approve" ? "Approving…" : `Approve ${profile.name}`}
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
        <p className={`proposal-outcome status-${proposal.status}`}>
          <strong>{STATUS_LABELS[proposal.status]}</strong>
          {proposal.decidedAt && <span className="muted"> · {formatDateTime(proposal.decidedAt)}</span>}
          {proposal.outcome && <span className="block">{proposal.outcome}</span>}
        </p>
      )}
    </article>
  );
}
