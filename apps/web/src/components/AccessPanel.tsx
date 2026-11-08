import { useEffect, useId, useState } from "react";
import type { Agent, Service, ServiceGrant, SourceConnection, StaffReader, StaffTools, WebGrant } from "@aihub/shared";
import { errorText, loadAccess } from "../api.ts";
import { CONNECTION_STATUS_LABELS, formatDateTime } from "../format.ts";
import { grantsOn, holdersOf, inUse, listedServices, SERVICE_KIND_LABELS, SERVICE_STATUS_LABELS, serviceOf, unsafeRows } from "../lib/access.ts";
import { BUILT_IN_READERS, readerName, readerOf, READER_STATUS_LABELS, STAFF_READER_PREFIX } from "../lib/sources.ts";
import { Icon } from "./Icon.tsx";
import { OperationList, ServiceActions } from "./ServiceCard.tsx";

// The Access panel (DESIGN.md › Authority and data boundaries): everything staff can reach beyond
// their own notes, with who has access and when it was last used. Grants that break the data
// boundary come first. Taking one back takes effect at the next call.

interface AccessPanelProps {
  services: Service[];
  grants: ServiceGrant[];
  connections: SourceConnection[];
  readers: StaffReader[];
  agents: Agent[];
  /** Show only this staff member's rows, as the profile card's link asks. */
  focusId: string | null;
  onFocus(agentId: string | null): void;
  agentName(agentId: string | null): string;
  onSelectAgent(agentId: string): void;
  onRevokeGrant(grantId: number): Promise<void>;
  onRevokeSource(connectionId: string, agentId: string): Promise<void>;
  onSetWeb(agentId: string, web: WebGrant | null): Promise<void>;
  onSignIn(serviceId: string): Promise<string>;
  onRefresh(serviceId: string): Promise<void>;
  onRemove(serviceId: string): Promise<void>;
  onClose(): void;
}

export function AccessPanel(props: AccessPanelProps) {
  const { agents, focusId, agentName } = props;
  const id = useId();
  const [tools, setTools] = useState<StaffTools[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  // The gateway decides tools from roles, grants, and what each staff member has to do, so read them again when those change.
  const toolsKey = `${agents.map((agent) => `${agent.id}:${agent.state}`).join(",")}|${props.grants.map((grant) => grant.id).join(",")}`;
  useEffect(() => {
    let current = true;
    loadAccess().then(
      (response) => current && (setTools(response.staff), setToolsError(null)),
      (failure) => current && setToolsError(errorText(failure)),
    );
    return () => {
      current = false;
    };
  }, [toolsKey]);

  const focused = focusId ? (agents.find((agent) => agent.id === focusId) ?? null) : null;
  const mine = (agentId: string | null) => !focused || agentId === focused.id;
  const unsafe = unsafeRows(props.services, props.grants, agents).filter((row) => mine(row.agentId));
  const grants = props.grants.filter((grant) => mine(grant.agentId));
  // A source nobody holds any more, such as one on a removed service, reaches nobody.
  const connections = props.connections.filter((connection) => holdersOf(connection, agents).some((agent) => mine(agent.id)));
  const services = listedServices(props.services).filter(
    (service) => !focused || grants.some((grant) => grant.serviceId === service.id) || connections.some((connection) => connection.service?.serviceId === service.id),
  );
  const searchers = agents.filter((agent) => agent.web && mine(agent.id));

  return (
    <aside className="drawer access-drawer" aria-labelledby={`${id}-title`}>
      <header className="drawer-head">
        <span className="drawer-icon" aria-hidden="true">
          <Icon name="key" size={20} />
        </span>
        <div className="drawer-title">
          <h2 id={`${id}-title`}>Access</h2>
          <p className="muted small">What staff can reach beyond their own notes, and who holds it.</p>
        </div>
        <button type="button" className="icon-button" onClick={props.onClose} title="Close access">
          <Icon name="close" />
          <span className="visually-hidden">Close access</span>
        </button>
      </header>

      <div className="drawer-body access-body">
        {focused && (
          <p className="access-focus small">
            Showing what {focused.name} holds.{" "}
            <button type="button" className="link-button" onClick={() => props.onFocus(null)}>
              Show everyone
            </button>
          </p>
        )}

        <section className="access-section" aria-labelledby={`${id}-unsafe`}>
          <h3 id={`${id}-unsafe`}>
            <Icon name="warning" size={16} /> Unsafe grants
          </h3>
          {unsafe.length === 0 ? (
            <p className="muted small">None. Nothing staff hold can send what they read out of the office.</p>
          ) : (
            <ul className="access-list">
              {unsafe.map((row) => (
                <li key={row.key} className="access-row unsafe">
                  <div>
                    <strong>{row.what}</strong>
                    {row.agentId && (
                      <>
                        {" "}
                        <span className="muted">·</span> <AgentLink agentId={row.agentId} name={agentName(row.agentId)} onSelect={props.onSelectAgent} />
                      </>
                    )}
                    <span className="block small">{row.risk}</span>
                  </div>
                  {row.grantId !== undefined && <ActionButton label="Revoke" busyLabel="Revoking…" onAct={() => props.onRevokeGrant(row.grantId!)} />}
                  {row.kind === "web" && row.agentId && (
                    <ActionButton
                      label="Make cached"
                      busyLabel="Saving…"
                      onAct={() => props.onSetWeb(row.agentId!, { sites: agents.find((agent) => agent.id === row.agentId)?.web?.sites ?? [], live: false })}
                    />
                  )}
                  {row.serviceId && <ActionButton label="Remove" busyLabel="Removing…" confirm="Remove it?" onAct={() => props.onRemove(row.serviceId!)} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="access-section" aria-labelledby={`${id}-services`}>
          <h3 id={`${id}-services`}>
            <Icon name="plug" size={16} /> Services
          </h3>
          {services.length === 0 ? (
            <p className="muted small">{focused ? `${focused.name} uses no services.` : "None yet. Ask the Chief of Staff to connect an account, such as your mail."}</p>
          ) : (
            <ul className="access-list">
              {services.map((service) => (
                <li key={service.id} className={`access-row service-row${service.unsafe ? " unsafe" : ""}`}>
                  <div className="access-main">
                    <p>
                      <span className={`dot status-${service.status}`} aria-hidden="true" /> <strong>{service.name}</strong>{" "}
                      <span className={`pill tiny service-status status-${service.status}`}>{SERVICE_STATUS_LABELS[service.status]}</span>
                    </p>
                    <p className="small muted">
                      {SERVICE_KIND_LABELS[service.kind]}: <span className="connection-path">{service.where}</span>
                      {service.account ? `, as ${service.account}` : ""}
                    </p>
                    {service.detail && <p className="small">{service.detail}</p>}
                    <OperationList service={service} />
                    <GrantList grants={grantsOn(service, props.grants).filter((grant) => mine(grant.agentId))} agentName={agentName} onSelect={props.onSelectAgent} onRevoke={props.onRevokeGrant} />
                    {props.connections
                      .filter((connection) => connection.service?.serviceId === service.id && holdersOf(connection, agents).length > 0)
                      .map((connection) => (
                        <p key={connection.id} className="small">
                          Source <strong>{connection.label}</strong> reads <code>{connection.service?.operation}</code> for{" "}
                          {holdersOf(connection, agents).map((agent) => agent.name).join(", ")}.
                        </p>
                      ))}
                    {service.status === "proposed" ? (
                      <p className="tiny muted">Waiting for you on its card in the Chief of Staff's chat.</p>
                    ) : (
                      inUse(service) && <ServiceActions service={service} onSignIn={() => props.onSignIn(service.id)} onRefresh={() => props.onRefresh(service.id)} />
                    )}
                    {service.checkedAt && <p className="tiny muted">Checked {formatDateTime(service.checkedAt)}</p>}
                  </div>
                  {inUse(service) && <ActionButton label="Remove" busyLabel="Removing…" confirm={`Remove ${service.name}?`} onAct={() => props.onRemove(service.id)} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="access-section" aria-labelledby={`${id}-sources`}>
          <h3 id={`${id}-sources`}>
            <Icon name="folder" size={16} /> Sources
          </h3>
          {connections.length === 0 ? (
            <p className="muted small">{focused ? `${focused.name} reads no sources.` : "No sources yet."}</p>
          ) : (
            <ul className="access-list">
              {connections.map((connection) => {
                const holders = holdersOf(connection, agents).filter((agent) => mine(agent.id));
                const service = serviceOf(connection, props.services);
                return (
                  <li key={connection.id} className="access-row">
                    <div className="access-main">
                      <p>
                        <span className={`dot status-${connection.status}`} aria-hidden="true" /> <strong>{connection.label}</strong>{" "}
                        <span className={`pill tiny status-${connection.status}`}>{CONNECTION_STATUS_LABELS[connection.status]}</span>
                      </p>
                      <p className="small muted">
                        {connection.kind === "service"
                          ? `${connection.service?.operation ?? "An operation"} on ${service?.name ?? "a removed service"}`
                          : connection.kind === "folder"
                            ? `Folder ${connection.path}, ${connection.pattern ?? "*"}, read by ${readerName(readerOf(connection.reader, props.readers))}`
                            : `Calendar file ${connection.path}`}
                      </p>
                      {connection.detail && <p className="small">{connection.detail}</p>}
                      {connection.verifiedAt && <p className="tiny muted">Last read {formatDateTime(connection.verifiedAt)}</p>}
                      {holders.length === 0 ? (
                        <p className="tiny muted">Nobody reads it any more.</p>
                      ) : (
                        <ul className="holder-list">
                          {holders.map((agent) => (
                            <li key={agent.id}>
                              <AgentLink agentId={agent.id} name={agent.name} onSelect={props.onSelectAgent} />
                              <ActionButton small label="Revoke" busyLabel="Revoking…" confirm="Take it away?" onAct={() => props.onRevokeSource(connection.id, agent.id)} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!focused && (
          <section className="access-section" aria-labelledby={`${id}-readers`}>
            <h3 id={`${id}-readers`}>
              <Icon name="file" size={16} /> Readers
            </h3>
            <ul className="access-list">
              {Object.entries(BUILT_IN_READERS).map(([name, reader]) => (
                <li key={name} className="access-row">
                  <div className="access-main">
                    <p>
                      <strong>{reader.label}</strong> <span className="pill tiny">Built in</span>
                    </p>
                    <p className="small muted">
                      {reader.pattern}: {reader.records}
                    </p>
                    <UsedBy connections={props.connections.filter((connection) => connection.reader === name)} />
                  </div>
                </li>
              ))}
              {props.readers
                .filter((reader) => reader.status !== "drafting")
                .map((reader) => (
                  <li key={reader.id} className="access-row">
                    <div className="access-main">
                      <p>
                        <strong>{reader.name}</strong> <span className={`pill tiny reader-status status-${reader.status}`}>{READER_STATUS_LABELS[reader.status]}</span>
                      </p>
                      <p className="small muted">
                        {reader.pattern}, written by {reader.authorName ?? "a toolsmith"}. It runs in the sandbox, with no network.
                      </p>
                      <UsedBy connections={props.connections.filter((connection) => connection.reader === `${STAFF_READER_PREFIX}${reader.id}`)} />
                      {reader.code && (
                        <details className="reader-code">
                          <summary>{reader.status === "approved" ? "The approved code" : "Its code"}</summary>
                          <pre>
                            <code>{reader.code}</code>
                          </pre>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}

        <section className="access-section" aria-labelledby={`${id}-web`}>
          <h3 id={`${id}-web`}>
            <Icon name="globe" size={16} /> Web search
          </h3>
          {searchers.length === 0 ? (
            <p className="muted small">{focused ? `${focused.name} can't search the web.` : "Nobody can search the web."}</p>
          ) : (
            <ul className="access-list">
              {searchers.map((agent) => (
                <li key={agent.id} className={`access-row${agent.web?.live ? " unsafe" : ""}`}>
                  <div className="access-main">
                    <p>
                      <AgentLink agentId={agent.id} name={agent.name} onSelect={props.onSelectAgent} />{" "}
                      <span className={`pill tiny${agent.web?.live ? " unsafe-optional" : ""}`}>{agent.web?.live ? "Live" : "Cached"}</span>
                    </p>
                    <p className="small muted">{agent.web?.sites.length ? `Only ${agent.web.sites.join(", ")}` : "Any site"}</p>
                  </div>
                  <ActionButton label="Turn off" busyLabel="Turning off…" onAct={() => props.onSetWeb(agent.id, null)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="access-section" aria-labelledby={`${id}-tools`}>
          <h3 id={`${id}-tools`}>
            <Icon name="list" size={16} /> Staff tools
          </h3>
          <p className="tiny muted">The AiHub tools each kind of run gets, as the gateway gives them. The gateway checks every call again.</p>
          {toolsError && <p className="form-error small">{toolsError}</p>}
          {tools === null && !toolsError && <p className="muted small">Reading…</p>}
          {tools && (
            <ul className="access-list">
              {tools
                .filter((entry) => mine(entry.agentId) && agents.some((agent) => agent.id === entry.agentId))
                .map((entry) => (
                  <li key={entry.agentId} className="access-row">
                    <div className="access-main">
                      <p>
                        <AgentLink agentId={entry.agentId} name={agentName(entry.agentId)} onSelect={props.onSelectAgent} />
                      </p>
                      <dl className="tool-kinds">
                        {entry.kinds.map((kind) => (
                          <div key={kind.kind}>
                            <dt>{RUN_KIND_LABELS[kind.kind] ?? kind.kind}</dt>
                            <dd>
                              {kind.tools.map((tool) => (
                                <code key={tool} className={UNSAFE_TOOLS.has(tool) ? "unsafe-tool" : undefined}>
                                  {tool.replace(/^aihub_/, "")}
                                </code>
                              ))}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

const RUN_KIND_LABELS: Record<string, string> = {
  chat: "Chat",
  briefing: "Briefing",
  report: "Briefing report",
  question: "Question",
  assignment: "Task",
  follow_up: "Follow-up",
  review: "Staff review",
};

/** Tools that can reach outside the office, when the operator granted something unsafe through them. */
const UNSAFE_TOOLS = new Set(["aihub_use_service"]);

function GrantList({
  grants,
  agentName,
  onSelect,
  onRevoke,
}: {
  grants: ServiceGrant[];
  agentName(agentId: string): string;
  onSelect(agentId: string): void;
  onRevoke(grantId: number): Promise<void>;
}) {
  if (!grants.length) return <p className="tiny muted">No staff member may call its operations.</p>;
  return (
    <ul className="holder-list">
      {grants.map((grant) => (
        <li key={grant.id} className={grant.unsafe ? "unsafe" : undefined}>
          <span>
            <AgentLink agentId={grant.agentId} name={agentName(grant.agentId)} onSelect={onSelect} /> may call <code>{grant.operation}</code>
            {grant.unsafe && <span className="pill tiny unsafe-optional">Unsafe</span>}
            <span className="block tiny muted">{grant.lastUsedAt ? `Last used ${formatDateTime(grant.lastUsedAt)}` : "Never used"}</span>
          </span>
          <ActionButton small label="Revoke" busyLabel="Revoking…" onAct={() => onRevoke(grant.id)} />
        </li>
      ))}
    </ul>
  );
}

function UsedBy({ connections }: { connections: SourceConnection[] }) {
  if (!connections.length) return <p className="tiny muted">No source uses it.</p>;
  return <p className="tiny muted">Used by {connections.map((connection) => connection.label).join(", ")}.</p>;
}

function AgentLink({ agentId, name, onSelect }: { agentId: string; name: string; onSelect(agentId: string): void }) {
  return (
    <button type="button" className="link-button" onClick={() => onSelect(agentId)}>
      {name}
    </button>
  );
}

/** A button that acts once, says so while it does, and shows why it failed. With `confirm`, the first click asks. */
function ActionButton({ label, busyLabel, confirm, small, onAct }: { label: string; busyLabel: string; confirm?: string; small?: boolean; onAct(): Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async () => {
    if (confirm && !asking) {
      setAsking(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAct();
      setAsking(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="action-button">
      <button type="button" className={`button ${asking ? "danger" : "ghost"} small`} disabled={busy} onClick={() => void act()} onBlur={() => !busy && setAsking(false)}>
        {busy ? busyLabel : asking ? confirm : label}
      </button>
      {error && (
        <span className="form-error tiny block" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
