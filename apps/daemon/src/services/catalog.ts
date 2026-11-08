import type { OperationLabel, Service, ServiceOperation, UnsafeGrant } from "@aihub/shared";
import type { ServiceConfig, ServiceRecord, ServiceTool } from "../store/store.ts";
import type { ServiceEndpoint } from "../runtime/types.ts";

// What a service offers, and which grants on it break the data boundary (DESIGN.md › Authority and
// data boundaries). A service labels its own tools, so the labels are its claim: an unlabeled tool
// counts as changing things, and one that doesn't rule out reaching other parties counts as reaching them.

/** What an operation does, by the service's own label. */
export function labelOf(tool: ServiceTool): OperationLabel {
  const readOnly = tool.annotations?.readOnlyHint;
  if (readOnly === true) return "reads";
  if (readOnly === false) return "changes";
  return "unlabeled";
}

/** MCP's default is that a tool may reach an open world of other parties, so only an explicit no rules it out. */
export function opensWorld(tool: ServiceTool): boolean {
  return tool.annotations?.openWorldHint !== false;
}

/** A program on this PC runs outside AiHub's sandbox, with the operator's access to files and the network. */
export function localRisk(service: Pick<ServiceRecord, "name">): string {
  return `${service.name} is a program on this PC that runs outside AiHub's sandbox, with your access to files and the internet.`;
}

/**
 * Why a staff member calling this operation with arguments of its own breaks the data boundary, or
 * null when it doesn't: it only reads the service and reaches no one else.
 */
export function operationRisk(service: Pick<ServiceRecord, "name" | "kind">, tool: ServiceTool, staffName: string): string | null {
  if (service.kind === "local_mcp") return `${localRisk(service)} Something ${staffName} reads could tell them what to ask of it.`;
  const label = labelOf(tool);
  if (label === "changes") return `${tool.name} changes things outside the office. Something ${staffName} reads could tell them to use it, such as to send what they know to anyone.`;
  if (label === "unlabeled") return `${service.name} doesn't say what ${tool.name} does, so it counts as changing things. Something ${staffName} reads could tell them to use it.`;
  if (opensWorld(tool)) return `${service.name} doesn't rule out that ${tool.name} reaches parties other than itself. Something ${staffName} reads could make them send what they know there.`;
  return null;
}

/**
 * Why reading a source through this operation at every briefing breaks the boundary, or null. The
 * arguments are fixed on the card, so nothing a staff member reads can steer the call: only what the
 * operation does on its own matters.
 */
export function collectionRisk(service: Pick<ServiceRecord, "name">, tool: ServiceTool): string | null {
  const label = labelOf(tool);
  if (label === "reads") return null;
  const said = label === "changes" ? `says ${tool.name} changes things` : `doesn't say what ${tool.name} does`;
  return `${service.name} ${said}, and reading the source runs it at every briefing.`;
}

/** The key the operator ticks for an unsafe grant. */
export const unsafeKey = {
  service: (serviceId: string) => `service:${serviceId}`,
  source: (serviceId: string, operation: string) => `source:${serviceId}/${operation}`,
  operation: (serviceId: string, operation: string) => `operation:${serviceId}/${operation}`,
  liveWeb: "web:live",
} as const;

/** What a staff member with live search could do, for the card. */
export function liveWebRisk(staffName: string): UnsafeGrant {
  return {
    key: unsafeKey.liveWeb,
    what: "Live web search",
    risk: `Live search opens pages on the sites themselves. Something ${staffName} reads could make them put what they know in an address a site's owner sees.`,
    required: false,
  };
}

/** Where the runtime reaches the service. */
export function endpointOf(config: ServiceConfig): ServiceEndpoint {
  if (config.kind === "app") return { kind: "app", appId: config.appId };
  if (config.kind === "remote_mcp") return { kind: "remote_mcp", server: config.server, url: config.url };
  return { kind: "local_mcp", server: config.server, command: config.command, args: config.args };
}

export function operationsOf(tools: ServiceTool[]): ServiceOperation[] {
  return tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, label: labelOf(tool), openWorld: opensWorld(tool) }));
}

/** A service as the office shows it. */
export function publicService(record: ServiceRecord): Service {
  const { config } = record;
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    where: config.kind === "app" ? `${config.appName}, a ChatGPT app` : config.kind === "remote_mcp" ? config.url : [config.command, ...config.args].join(" "),
    account: config.kind === "app" ? config.account : null,
    status: record.status,
    detail: record.detail,
    operations: operationsOf(record.tools),
    reason: record.reason,
    proposedBy: record.proposedBy,
    unsafe: record.unsafe,
    connectUrl: config.kind === "app" ? config.connectUrl : null,
    checkedAt: record.checkedAt,
    createdAt: record.createdAt,
  };
}

/** A tool's input, cut down to what staff need to call it: the properties, their types, and what is required. */
export function describeInput(schema: unknown): string {
  const object = typeof schema === "object" && schema !== null ? (schema as { properties?: Record<string, { type?: unknown; description?: string }>; required?: string[] }) : {};
  const properties = Object.entries(object.properties ?? {}).filter(([name]) => name !== "link_id");
  if (!properties.length) return "no arguments";
  const required = new Set(object.required ?? []);
  return properties
    .map(([name, property]) => {
      const type = Array.isArray(property.type) ? property.type.join("|") : typeof property.type === "string" ? property.type : "any";
      const note = property.description ? `: ${property.description.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `${name} (${type}${required.has(name) ? ", required" : ""})${note}`;
    })
    .join("; ");
}

/** A tool's declared output, cut short, so the Chief of Staff can write a mapping. */
export function describeOutput(schema: unknown): string {
  if (!schema) return "not declared";
  const text = JSON.stringify(schema);
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}
