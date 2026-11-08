import type { UnsafeGrant } from "@aihub/shared";
import { Icon } from "./Icon.tsx";

// Grants that break the data boundary, each with its own tick (DESIGN.md › Authority and data
// boundaries). Approve alone never covers one: a required one blocks approval until ticked, and an
// optional one left unticked is left out.

interface UnsafeGrantsProps {
  grants: UnsafeGrant[];
  ticked: ReadonlySet<string>;
  disabled: boolean;
  onToggle(key: string, on: boolean): void;
}

export function UnsafeGrants({ grants, ticked, disabled, onToggle }: UnsafeGrantsProps) {
  if (!grants.length) return null;
  return (
    <fieldset className="unsafe-grants">
      <legend>
        <Icon name="warning" size={16} /> {grants.length === 1 ? "This breaks" : "These break"} the data boundary
      </legend>
      <p className="tiny muted">Tick each one you allow. Approving alone allows none of them.</p>
      <ul>
        {grants.map((grant) => (
          <li key={grant.key}>
            <label>
              <input type="checkbox" checked={ticked.has(grant.key)} disabled={disabled} onChange={(event) => onToggle(grant.key, event.target.checked)} />
              <span>
                <strong>{grant.what}</strong>
                <span className={`pill tiny ${grant.required ? "unsafe-required" : "unsafe-optional"}`}>{grant.required ? "Needed to approve" : "Left out unless ticked"}</span>
                <span className="block small">{grant.risk}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
