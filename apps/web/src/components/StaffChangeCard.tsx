import { useState } from "react";
import type { ModelOption, StaffChange } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatDateTime } from "../format.ts";
import { lookFor } from "../lib/avatar.ts";
import { describeModel } from "../lib/models.ts";
import { grantsNothing, modelBefore, staffChangeTitle } from "../lib/staff-changes.ts";
import { Icon } from "./Icon.tsx";
import { Portrait } from "./office/Figure.tsx";
import { PolicyDiff } from "./PolicyCard.tsx";
import { toggled } from "./ServiceCard.tsx";
import { UnsafeGrants } from "./UnsafeGrants.tsx";

// The approval card for a change to a supervisor that the Chief of Staff proposed (DESIGN.md › Staff
// review): new instructions, another model, more operations on a service, ending the responsibility,
// or a replacement. It shows what changes; nothing applies until the operator approves, and an unsafe
// operation only with its own tick.

const STATUS_LABELS: Record<StaffChange["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

interface StaffChangeCardProps {
  change: StaffChange | undefined;
  /** The chat message that carried the card. */
  intro: string;
  authorName: string;
  models: ModelOption[] | null;
  /** `unsafe` holds the keys of the unsafe grants the operator ticked. */
  onApprove(unsafe: string[]): Promise<void>;
  onDecline(): Promise<void>;
}

export function StaffChangeCard({ change, intro, authorName, models, onApprove, onDecline }: StaffChangeCardProps) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

  if (!change) {
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
      await (which === "approve" ? onApprove([...ticked]) : onDecline());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const title = staffChangeTitle(change, models);
  const unsafe = change.change.kind === "operations" ? change.change.unsafe : [];
  const blocked = grantsNothing(change, ticked);
  return (
    <article className={`card policy-card staff-change-card status-${change.status}`} aria-label={`Proposal: ${title}`}>
      <header className="policy-card-head">
        <Icon name="team" size={18} />
        <p className="eyebrow">Staff change</p>
        <span className={`pill policy-status-${change.status}`}>{STATUS_LABELS[change.status]}</span>
      </header>
      <h3 className="staff-change-title">{title}</h3>
      <p>{change.reason}</p>
      {change.fromSourceData && change.status === "pending" && (
        <p className="callout warn">
          <Icon name="warning" size={16} /> {authorName} proposed this in a chat that had taken in data from your sources or the web. Check that it is a change you want.
        </p>
      )}
      <ChangeDetail change={change} models={models} />
      {change.status === "pending" && (
        <UnsafeGrants grants={unsafe} ticked={ticked} disabled={busy !== null} onToggle={(key, on) => setTicked(toggled(ticked, key, on))} />
      )}
      {change.status === "pending" && blocked && <p className="muted small">Every operation here is unsafe. Tick the ones you allow, or decline.</p>}
      {change.status === "pending" ? (
        <div className="button-row">
          <button type="button" className="button primary" disabled={busy !== null || blocked} onClick={() => void decide("approve")}>
            <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button type="button" className="button ghost" disabled={busy !== null} onClick={() => void decide("decline")}>
            {busy === "decline" ? "Declining…" : "Decline"}
          </button>
        </div>
      ) : (
        <p className="muted small">
          {STATUS_LABELS[change.status]}
          {change.decidedAt && ` ${formatDateTime(change.decidedAt)}`}
          {change.outcome && `: ${change.outcome}`}
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

function ChangeDetail({ change, models }: { change: StaffChange; models: ModelOption[] | null }) {
  const { agentName: name, responsibilityTitle: title } = change;
  const detail = change.change;
  switch (detail.kind) {
    case "instructions":
      return (
        <div className="staff-change-detail">
          {detail.scope !== detail.before.scope && (
            <>
              <p className="eyebrow">Scope of {title}</p>
              <PolicyDiff before={detail.before.scope} after={detail.scope} />
            </>
          )}
          {detail.standingInstructions !== detail.before.standingInstructions && (
            <>
              <p className="eyebrow">Standing instructions</p>
              <PolicyDiff before={detail.before.standingInstructions} after={detail.standingInstructions} />
            </>
          )}
        </div>
      );
    case "model":
      return (
        <dl className="facts">
          <div>
            <dt>Now</dt>
            <dd>{modelBefore(change, models)}</dd>
          </div>
          <div>
            <dt>Then</dt>
            <dd>
              {describeModel(detail.model.id, detail.model.effort, models)}. {detail.model.why}
            </dd>
          </div>
        </dl>
      );
    case "operations":
      return (
        <div className="staff-change-detail">
          <p className="eyebrow">{name} may also call</p>
          <ul className="operation-grants">
            {detail.operations.map((operation) => (
              <li key={`${operation.serviceId}/${operation.operation}`}>
                <code>{operation.operation}</code> on {operation.serviceName}
                {operation.unsafe && <span className="pill tiny unsafe-optional">Unsafe</span>}
                <span className="block muted small">{operation.why}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">With aihub_use_service, in chat and tasks. Every call shows in the activity log, and you can take any of it back in Access.</p>
        </div>
      );
    case "end":
      return (
        <p className="staff-change-detail">
          {title} ends, and {name} leaves the office with their access revoked. Their items, runs, and notes stay.
        </p>
      );
    case "replace": {
      const { profile, model } = detail;
      return (
        <div className="staff-change-detail">
          <div className="staff-change-person">
            <Portrait look={lookFor(profile.name)} size={56} label={`How ${profile.name} might look`} />
            <div>
              <p className="staff-change-name">{profile.name}</p>
              <p className="muted small">{profile.title}</p>
            </div>
          </div>
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
              <dt>Runs on</dt>
              <dd>{model ? `${describeModel(model.id, model.effort, models)}. ${model.why}` : `What ${name} runs on.`}</dd>
            </div>
          </dl>
          <p className="muted small">
            {profile.name} takes over {title} with its sources, web search, and items, and starts with empty notes. {name} leaves the office.
          </p>
        </div>
      );
    }
  }
}
