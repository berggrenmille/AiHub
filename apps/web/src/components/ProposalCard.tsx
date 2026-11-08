import { useId, useRef, useState, type FormEvent } from "react";
import type { ModelOption, Proposal, ProposedSource, Service, SourcePreview, StaffReader } from "@aihub/shared";
import { errorText } from "../api.ts";
import { lookFor } from "../lib/avatar.ts";
import { approvalGate, describeSource, patternOf, previewRows, READER_STATUS_LABELS, readerOf, type PreviewState } from "../lib/sources.ts";
import { formatDateTime } from "../format.ts";
import { describeModel } from "../lib/models.ts";
import { Portrait } from "./office/Figure.tsx";
import { Icon } from "./Icon.tsx";
import { missingTicks } from "../lib/access.ts";
import { toggled } from "./ServiceCard.tsx";
import { UnsafeGrants } from "./UnsafeGrants.tsx";

// An approval card for a proposal in the Chief of Staff's chat (DESIGN.md › Recruitment and
// delegation): who would join, what they'd own, what they'd watch, and why. A source can be
// previewed at the path the operator picks; one on a reader staff wrote must be (DESIGN.md ›
// Connectors and capabilities), since approving the supervisor approves the reader too.

interface ProposalCardProps {
  proposal: Proposal | undefined;
  /** The chat message that carried the card. */
  intro: string;
  readers: StaffReader[];
  /** For naming the service a source or operation is on. */
  services: Service[];
  /** For naming the model the proposal picks. */
  models: ModelOption[] | null;
  onPreview(sourcePath: string): Promise<SourcePreview>;
  /** `unsafe` holds the keys of the unsafe grants the operator ticked. */
  onApprove(sourcePath: string | undefined, unsafe: string[]): Promise<void>;
  onDecline(): Promise<void>;
}

const STATUS_LABELS: Record<Proposal["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
};

export function ProposalCard({ proposal, intro, readers, services, models, onPreview, onApprove, onDecline }: ProposalCardProps) {
  const [path, setPath] = useState("");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  // Only the latest preview counts: an answer for a path since changed is dropped.
  const previewTicket = useRef(0);
  const pathId = useId();

  if (!proposal) {
    return (
      <div className="card proposal-card">
        <p>{intro}</p>
        <p className="muted small">This proposal is no longer on file.</p>
      </div>
    );
  }

  const { profile, responsibility, source, web, model, reason } = proposal.payload;
  const operations = proposal.payload.operations ?? [];
  const unsafe = proposal.payload.unsafe ?? [];
  const pending = proposal.status === "pending";
  const onService = source?.kind === "service";
  const pathNeeded = pending && source !== null && !onService;
  const trimmed = onService ? "" : path.trim();
  const looksLikeIcs = /\.ics$/i.test(trimmed);
  const sourceService = onService ? services.find((service) => service.id === source.service?.serviceId) : undefined;
  const described = source ? describeSource(source, readers, sourceService?.name) : null;
  const gate = approvalGate(source, readers, trimmed, preview);
  const missing = missingTicks(unsafe, ticked);
  const previewedCode = preview.status === "done" ? preview.preview.code : null;

  const run = async (kind: "approve" | "decline") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "approve") await onApprove(source && !onService ? trimmed : undefined, [...ticked]);
      else await onDecline();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const whatToPick = source ? `the ${source.label.toLowerCase()} ${source.kind === "folder" ? "folder" : "file"}` : "";

  const changePath = (value: string) => {
    setPath(value);
    // A preview stands for the path it read; another path needs its own.
    if (preview.status !== "idle" && value.trim() !== preview.path) {
      previewTicket.current++;
      setPreview({ status: "idle" });
    }
  };

  const runPreview = async () => {
    if (!trimmed && !onService) {
      setError(`Enter the path of ${whatToPick} first.`);
      return;
    }
    const ticket = ++previewTicket.current;
    setError(null);
    setPreview({ status: "loading", path: trimmed });
    try {
      const result = await onPreview(trimmed);
      if (ticket === previewTicket.current) setPreview({ status: "done", path: trimmed, preview: result });
    } catch (failure) {
      if (ticket === previewTicket.current) setPreview({ status: "failed", path: trimmed, error: errorText(failure) });
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pathNeeded && !trimmed) {
      setError(`Enter the path of ${whatToPick} first.`);
      return;
    }
    if (!gate.ready) {
      setError(gate.reason);
      return;
    }
    if (missing.length) {
      setError(`Tick “${missing[0]!.what}” first.`);
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
          <dd>{source && described ? `${source.label} (${described.kind})` : web ? "None: searches the web instead" : "None needed"}</dd>
        </div>
        {onService && (
          <div>
            <dt>Account</dt>
            <dd>
              {sourceService ? `${sourceService.name}, ${sourceService.where}` : "A service no longer on file"}
              <span className="block muted">AiHub calls it in code at each briefing, with arguments fixed here, and hands the supervisor what it reads as data.</span>
            </dd>
          </div>
        )}
        {operations.length > 0 && (
          <div>
            <dt>May call</dt>
            <dd>
              <ul className="operation-grants">
                {operations.map((operation) => (
                  <li key={`${operation.serviceId}/${operation.operation}`}>
                    <code>{operation.operation}</code> on {operation.serviceName}
                    {operation.unsafe && <span className="pill tiny unsafe-optional">Unsafe</span>}
                    <span className="block muted small">{operation.why}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {web && (
          <div>
            <dt>Web search</dt>
            <dd>
              {web.sites.length ? `Only ${web.sites.join(", ")}` : "Any site"}
              <span className="block muted">
                {web.live
                  ? "Live search opens pages on the sites themselves, so only if you tick it below. Otherwise it searches OpenAI's index."
                  : "Searches OpenAI's index and opens no live pages, so no site sees what is looked up."}
              </span>
            </dd>
          </div>
        )}
        {source?.kind === "folder" && <BuiltInReaderFact source={source} readers={readers} />}
        {model && (
          <div>
            <dt>Runs on</dt>
            <dd>
              {describeModel(model.id, model.effort, models)}
              <span className="block muted">{model.why} You can change it on the profile card later.</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Why</dt>
          <dd>{reason}</dd>
        </div>
      </dl>

      {source?.kind === "folder" && <StaffReaderBox source={source} readers={readers} code={previewedCode} />}

      {pending ? (
        <form className="proposal-actions" onSubmit={onSubmit}>
          {onService && (
            <div className="button-row">
              <button type="button" className="button" disabled={busy !== null || preview.status === "loading"} onClick={() => void runPreview()}>
                {preview.status === "loading" ? "Reading…" : `Preview ${source.label}`}
              </button>
            </div>
          )}
          {source && described && !onService && (
            <div className="field">
              <label htmlFor={pathId}>
                {source.label}: {described.pick}
              </label>
              <div className="path-row">
                <input
                  id={pathId}
                  type="text"
                  value={path}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={described.placeholder}
                  onChange={(event) => changePath(event.target.value)}
                />
                <button type="button" className="button" disabled={busy !== null || preview.status === "loading"} onClick={() => void runPreview()}>
                  {preview.status === "loading" ? "Reading…" : "Preview"}
                </button>
              </div>
              {source.kind === "ics_file" && trimmed && !looksLikeIcs && <p className="hint warn">That doesn't end in .ics. AiHub reads calendar files.</p>}
            </div>
          )}
          {source && <PreviewPanel state={preview} />}
          <UnsafeGrants grants={unsafe} ticked={ticked} disabled={busy !== null} onToggle={(key, on) => setTicked(toggled(ticked, key, on))} />
          {gate.reason && (
            <p className={`callout gate gate-${gate.tone}`}>
              <Icon name={gate.tone === "done" ? "check" : gate.tone === "blocked" ? "warning" : "lock"} size={16} />
              <span>{gate.reason}</span>
            </p>
          )}
          <div className="button-row">
            <button
              type="submit"
              className="button primary"
              disabled={busy !== null || !gate.ready || missing.length > 0}
              title={!gate.ready ? (gate.reason ?? undefined) : missing.length ? `Tick “${missing[0]!.what}” first` : undefined}
            >
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

/** A built-in reader in a line: which files it reads and what it makes of each. */
function BuiltInReaderFact({ source, readers }: { source: ProposedSource; readers: StaffReader[] }) {
  const info = readerOf(source.reader, readers);
  if (info?.kind === "staff") return null;
  return (
    <div>
      <dt>Reader</dt>
      <dd>
        {info?.kind === "built_in" ? (
          <>
            The built-in {info.label.toLowerCase()} reader, for the {patternOf(source, readers)} files in the folder.{" "}
            <span className="muted">{info.records}</span>
          </>
        ) : info ? (
          <>AiHub has no reader called “{info.name}”.</>
        ) : (
          <>None named.</>
        )}
      </dd>
    </div>
  );
}

/**
 * A reader a toolsmith wrote: its name, who wrote it, how far along it is, the toolsmith's notes,
 * and its code. The code a preview ran comes first, since that is what the operator approves.
 */
function StaffReaderBox({ source, readers, code }: { source: ProposedSource; readers: StaffReader[]; code: string | null }) {
  const info = readerOf(source.reader, readers);
  if (info?.kind !== "staff") return null;
  const reader = info.reader;
  if (!reader) {
    return (
      <section className="reader-box" aria-label="Reader">
        <p className="eyebrow">Reader</p>
        <p className="muted small">The reader this folder needs, written by staff, is no longer on file.</p>
      </section>
    );
  }
  const shown = code ?? reader.code;
  return (
    <section className="reader-box" aria-label={`The ${reader.name} reader`}>
      <p className="reader-head">
        <span>
          <span className="eyebrow">Reader written by staff</span>
          <strong className="block">{reader.name}</strong>
        </span>
        <span className={`pill reader-status status-${reader.status}`}>{READER_STATUS_LABELS[reader.status]}</span>
      </p>
      <p className="small">
        {reader.authorName ? `${reader.authorName} wrote it` : "A toolsmith wrote it"} for the {patternOf(source, readers)} files in the folder
        {reader.sampleNames.length > 0 ? `, and tested it on ${reader.sampleNames.join(", ")}` : ""}. It never saw your files.
      </p>
      {reader.notes && (
        <p className="reader-notes small">
          <span className="eyebrow">{reader.authorName ? `${reader.authorName}'s notes` : "Notes"}</span> {reader.notes}
        </p>
      )}
      {shown ? (
        <details className="reader-code">
          <summary>The reader's code</summary>
          <pre>
            <code>{shown}</code>
          </pre>
        </details>
      ) : (
        <p className="muted small">No code handed in yet.</p>
      )}
    </section>
  );
}

/** What a preview read at the path: the summary and the first records, or why it couldn't. */
function PreviewPanel({ state }: { state: PreviewState }) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <p className="preview-panel muted small" role="status">
        Reading {state.path}…
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <p className="preview-panel preview-failed form-error" role="alert">
        {state.error}
      </p>
    );
  }
  const rows = previewRows(state.preview.data);
  return (
    <section className="preview-panel" aria-label="Preview">
      <p className="eyebrow">Preview</p>
      <p className="small" role="status">
        {state.preview.summary}
      </p>
      {rows.length === 0 ? (
        <p className="muted small">Nothing to show from this path.</p>
      ) : (
        <ol className="preview-rows">
          {rows.map((row) => (
            <li key={row.key}>
              <p className="preview-title">
                <strong>{row.title}</strong>
                {row.detail && <span className="muted small"> {row.detail}</span>}
              </p>
              {row.fields.length > 0 && (
                <dl className="preview-fields">
                  {row.fields.map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
