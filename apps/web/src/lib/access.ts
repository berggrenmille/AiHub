// What staff can reach, as the operator sees it (DESIGN.md › Authority and data boundaries): services
// and their operations, sources, web search, and the grants among them that break the data boundary.
// Pure functions over records, so they can be tested on their own.

import type { Agent, OperationLabel, Service, ServiceGrant, ServiceKind, ServiceOperation, ServiceStatus, SourceConnection, UnsafeGrant } from "@aihub/shared";

export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  app: "ChatGPT app",
  remote_mcp: "MCP server",
  local_mcp: "Program on this PC",
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  proposed: "Waiting for you",
  signed_out: "Not signed in",
  connected: "Connected",
  failed: "Can't be reached",
  declined: "Declined",
  removed: "Removed",
};

export const OPERATION_LABELS: Record<OperationLabel, string> = {
  reads: "Reads",
  changes: "Changes things",
  unlabeled: "Unlabeled, counts as changing things",
};

/** What an operation does, in a few words: its label, and whether it may reach others. */
export function describeOperation(operation: Pick<ServiceOperation, "label" | "openWorld">): string {
  if (operation.label === "reads" && operation.openWorld) return "Reads, may reach others";
  return OPERATION_LABELS[operation.label];
}

/**
 * A service's operations in the order the operator reads them: those that only read first, then
 * those that may reach others, change things, or say nothing, each by name. A code host lists ninety.
 */
export function sortedOperations<T extends Pick<ServiceOperation, "name" | "label" | "openWorld">>(operations: readonly T[]): T[] {
  const rank = (operation: T) => (operation.label === "reads" ? (operation.openWorld ? 1 : 0) : operation.label === "changes" ? 2 : 3);
  return [...operations].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Approved and not removed: AiHub may call it once it is signed in. */
export function inUse(service: Service): boolean {
  return service.status === "connected" || service.status === "signed_out" || service.status === "failed";
}

/** Services to list: waiting or in use, those that break the data boundary first, then by name. */
export function listedServices(services: Service[]): Service[] {
  return services
    .filter((service) => service.status !== "declined" && service.status !== "removed")
    .sort((a, b) => Number(b.unsafe !== null) - Number(a.unsafe !== null) || a.name.localeCompare(b.name));
}

/** A grant that breaks the data boundary, for the top of the Access panel. */
export interface UnsafeRow {
  key: string;
  kind: "operation" | "service" | "web";
  /** What it grants, such as "send_message on Work mail". */
  what: string;
  /** Who holds it, or null for a service, which no staff member holds. */
  agentId: string | null;
  /** What could go wrong. */
  risk: string;
  /** For an operation: the grant to revoke. */
  grantId?: number;
  /** For a service: the service to remove. */
  serviceId?: string;
}

/** Every grant in force that breaks the data boundary: operations, programs on this PC, and live search. */
export function unsafeRows(services: Service[], grants: ServiceGrant[], agents: Agent[]): UnsafeRow[] {
  const names = new Map(services.map((service) => [service.id, service.name]));
  const present = new Set(agents.map((agent) => agent.id));
  const rows: UnsafeRow[] = [];
  for (const grant of grants) {
    if (!grant.unsafe || !present.has(grant.agentId)) continue;
    rows.push({
      key: `grant:${grant.id}`,
      kind: "operation",
      what: `${grant.operation} on ${names.get(grant.serviceId) ?? "a service"}`,
      agentId: grant.agentId,
      risk: grant.unsafe,
      grantId: grant.id,
    });
  }
  for (const service of services) {
    if (!service.unsafe || !inUse(service)) continue;
    rows.push({ key: `service:${service.id}`, kind: "service", what: service.unsafe.what, agentId: null, risk: service.unsafe.risk, serviceId: service.id });
  }
  for (const agent of agents) {
    if (!agent.web?.live) continue;
    rows.push({
      key: `web:${agent.id}`,
      kind: "web",
      what: "Live web search",
      agentId: agent.id,
      risk: `Live search opens pages on the sites themselves. Something ${agent.name} reads could make them put what they know in an address a site's owner sees.`,
    });
  }
  return rows;
}

/** The staff who hold a grant on a source. */
export function holdersOf(connection: SourceConnection, agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.connectionIds.includes(connection.id));
}

/** The operations staff may call on a service, with who holds each. */
export function grantsOn(service: Service, grants: ServiceGrant[]): ServiceGrant[] {
  return grants.filter((grant) => grant.serviceId === service.id);
}

/** The service a source reads, when it reads one. */
export function serviceOf(connection: SourceConnection, services: Service[]): Service | null {
  const id = connection.service?.serviceId;
  return id ? (services.find((service) => service.id === id) ?? null) : null;
}

/** The unsafe grants still unticked that approval can't do without. */
export function missingTicks(grants: UnsafeGrant[], ticked: ReadonlySet<string>): UnsafeGrant[] {
  return grants.filter((grant) => grant.required && !ticked.has(grant.key));
}
