import { useId, useState, type FormEvent } from "react";
import type { PolicyVersion } from "@aihub/shared";
import { errorText } from "../api.ts";
import { formatDateTime } from "../format.ts";
import { currentPolicy, pendingPolicy, POLICY_LIMIT } from "../lib/policy.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";

// The office policy (DESIGN.md › Memory and notes): the operator's rules for every staff member. The
// operator writes it here; a change the Chief of Staff proposes waits on a card in her chat.

interface PolicyDrawerProps {
  policies: PolicyVersion[];
  agentName(agentId: string | null): string;
  onSave(body: string): Promise<void>;
  /** Opens the chat where a proposal's card is. */
  onOpenProposal(): void;
  onClose(): void;
}

export function PolicyDrawer({ policies, agentName, onSave, onOpenProposal, onClose }: PolicyDrawerProps) {
  const current = currentPolicy(policies);
  const pending = pendingPolicy(policies);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const earlier = policies.filter((policy) => policy.status === "approved" && policy.id !== current?.id);
  const byLine = (policy: PolicyVersion) =>
    policy.authorId ? `Proposed by ${agentName(policy.authorId)}, approved by you` : "Written by you";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDraft(null);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="drawer policy-drawer" aria-labelledby={`${id}-title`}>
      <header className="drawer-head">
        <span className="drawer-icon" aria-hidden="true">
          <Icon name="policy" size={20} />
        </span>
        <div className="drawer-title">
          <h2 id={`${id}-title`}>Office policy</h2>
          <p className="muted small">Rules every staff member works under. Only you change them.</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Close the policy">
          <Icon name="close" />
          <span className="visually-hidden">Close the policy</span>
        </button>
      </header>
      <div className="drawer-body policy-body">
        {pending && (
          <p className="callout wait">
            <Icon name="hourglass" size={16} /> {agentName(pending.authorId)} proposed a change: {pending.reason}{" "}
            <button type="button" className="link-button" onClick={onOpenProposal}>
              Review it in the chat
            </button>
          </p>
        )}

        {draft !== null ? (
          <form className="policy-editor" onSubmit={(event) => void save(event)}>
            <label htmlFor={`${id}-body`}>
              The policy <span className="muted tiny">{draft.length}/{POLICY_LIMIT}</span>
            </label>
            <textarea
              id={`${id}-body`}
              rows={14}
              maxLength={POLICY_LIMIT}
              value={draft}
              placeholder={"- Write to me in English.\n- Anything about money is urgent the same day.\n- Never put my children's names in notes."}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="tiny muted">
              Short, specific rules work best. They apply from each staff member's next run, and can't give anyone access they don't have.
              {pending && ` Saving withdraws ${agentName(pending.authorId)}'s proposal.`}
            </p>
            <div className="button-row">
              <button type="submit" className="button primary" disabled={saving}>
                {saving ? "Saving…" : "Save policy"}
              </button>
              <button type="button" className="button ghost" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </form>
        ) : current?.body ? (
          <section aria-label="The current policy">
            <Markdown source={current.body} className="policy-text" />
            <p className="muted small">
              {byLine(current)} · {formatDateTime(current.decidedAt ?? current.createdAt)}
            </p>
            <button type="button" className="button ghost" onClick={() => setDraft(current.body)}>
              <Icon name="edit" size={16} /> Edit the policy
            </button>
          </section>
        ) : (
          <div className="empty-state">
            <Icon name="policy" size={28} />
            <p>
              No policy yet. Write the rules every staff member should follow, such as your language, what always counts as urgent, or what never goes in
              notes. Or tell the Chief of Staff, who proposes one for you to approve.
            </p>
            <button type="button" className="button primary" onClick={() => setDraft(current?.body ?? "")}>
              <Icon name="edit" size={16} /> Write the policy
            </button>
          </div>
        )}

        {earlier.length > 0 && (
          <details className="policy-history">
            <summary>Earlier versions ({earlier.length})</summary>
            <ol>
              {earlier.map((policy) => (
                <li key={policy.id}>
                  <details>
                    <summary>
                      {formatDateTime(policy.decidedAt ?? policy.createdAt)} · {byLine(policy)}
                    </summary>
                    {policy.body ? <Markdown source={policy.body} className="policy-text" /> : <p className="muted small">An empty policy.</p>}
                  </details>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </aside>
  );
}
