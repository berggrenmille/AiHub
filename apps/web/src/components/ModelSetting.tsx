import { useEffect, useId, useState, type FormEvent } from "react";
import type { Agent, ModelChoice, ModelOption, Run } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatAgo, formatDateTime } from "../format.ts";
import { defaultModel, describeModel, resolveChoice } from "../lib/models.ts";

// What a staff member runs on, on its profile card (DESIGN.md › Staff and work model): the model and
// reasoning level, what its last run actually used, and the form that changes them.

interface ModelSettingProps {
  agent: Agent;
  /** The models Codex offers, or null until they are loaded. */
  models: ModelOption[] | null;
  /** Its latest run that reported a model. */
  lastRun: Run | null;
  now: number;
  onLoad(): Promise<unknown>;
  onSet(choice: ModelChoice): Promise<void>;
}

export function ModelSetting({ agent, models, lastRun, now, onLoad, onSet }: ModelSettingProps) {
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(agent.model ?? "");
  const [effort, setEffort] = useState(agent.effort ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    if (models) return;
    onLoad().catch((failure: unknown) => setError(errorText(failure)));
  }, [models, onLoad]);

  const resolved = models ? resolveChoice(agent, models) : null;
  const retired = agent.model !== null && models !== null && !models.some((option) => option.id === agent.model);
  const failure = error && (
    <p className="form-error small" role="alert">
      {error}
    </p>
  );

  if (editing && models) {
    const office = defaultModel(models);
    const chosen = models.find((option) => option.id === model) ?? office;
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await onSet({ model: model || null, effort: effort || null });
        setEditing(false);
      } catch (failure) {
        setError(errorText(failure));
      } finally {
        setSaving(false);
      }
    };
    return (
      <form className="model-setting" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={`${id}-model`}>Model</label>
          <select
            id={`${id}-model`}
            value={model}
            onChange={(event) => {
              const next = models.find((option) => option.id === event.target.value) ?? office;
              setModel(event.target.value);
              // A level the new model lacks goes back to its default.
              if (effort && !next?.efforts.some((level) => level.effort === effort)) setEffort("");
            }}
          >
            <option value="">The office default{office ? ` (${office.name})` : ""}</option>
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {chosen && <p className="tiny muted">{chosen.description}</p>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-effort`}>Reasoning</label>
          <select id={`${id}-effort`} value={effort} onChange={(event) => setEffort(event.target.value)}>
            <option value="">The model's default{chosen ? ` (${chosen.defaultEffort})` : ""}</option>
            {chosen?.efforts.map((level) => (
              <option key={level.effort} value={level.effort}>
                {level.effort}: {level.description}
              </option>
            ))}
          </select>
        </div>
        <p className="tiny muted">More reasoning thinks longer and uses more of your plan on every run. The change applies from {agent.name}'s next run.</p>
        <div className="button-row">
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="button ghost" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        {failure}
      </form>
    );
  }

  return (
    <div className="model-setting">
      <div className="model-current">
        <span>
          {resolved ? (
            <>
              <strong>{resolved.option.name}</strong> · {resolved.effort} reasoning
            </>
          ) : (
            <strong>{agent.model ?? "The office default"}</strong>
          )}
          {agent.model === null && <span className="pill">Office default</span>}
        </span>
        <button
          type="button"
          className="button ghost small"
          disabled={!models}
          onClick={() => {
            setModel(agent.model ?? "");
            setEffort(agent.effort ?? "");
            setError(null);
            setEditing(true);
          }}
        >
          Change
        </button>
      </div>
      {resolved && <p className="muted small">{resolved.option.description}</p>}
      {retired && (
        <p className="callout warn small">
          Codex no longer offers {agent.model}, so {agent.name} runs on the office default until you pick another.
        </p>
      )}
      {lastRun?.model && (
        <p className="muted small">
          Last run used {describeModel(lastRun.model, lastRun.effort, models)} ·{" "}
          <time dateTime={lastRun.finishedAt ?? lastRun.queuedAt} title={formatDateTime(lastRun.finishedAt ?? lastRun.queuedAt)}>
            {formatAgo(lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.queuedAt, now)}
          </time>
        </p>
      )}
      {!models && !error && <p className="muted small">Loading the models Codex offers…</p>}
      {failure}
    </div>
  );
}
