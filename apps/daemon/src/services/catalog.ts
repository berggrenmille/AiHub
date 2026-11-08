import type { OperationLabel, ProposedOperation, Service, ServiceOperation, UnsafeGrant } from "@aihub/shared";
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

/**
 * Which tick an unsafe operation shares, by what it can do: reach other parties while only reading,
 * add or change things, or delete and overwrite them. MCP's default is that a tool that changes things
 * may destroy them, so only an explicit no puts it with the changes; an unlabeled tool counts as
 * destroying. A destructive operation never shares a tick with one that isn't.
 */
export type RiskGroup = "reach" | "change" | "destroy";

export function riskGroup(tool: ServiceTool): RiskGroup {
  const label = labelOf(tool);
  if (label === "reads") return "reach";
  return label === "changes" && tool.annotations?.destructiveHint === false ? "change" : "destroy";
}

/** The key the operator ticks for an unsafe grant. */
export const unsafeKey = {
  service: (serviceId: string) => `service:${serviceId}`,
  source: (serviceId: string, operation: string) => `source:${serviceId}/${operation}`,
  /** One operation's own tick, as cards had before operations were grouped. */
  operation: (serviceId: string, operation: string) => `operation:${serviceId}/${operation}`,
  /** The tick a service's unsafe operations of one kind share. */
  operations: (serviceId: string, group: RiskGroup) => `operations:${serviceId}/${group}`,
  liveWeb: "web:live",
} as const;

/** Whether a proposed operation may be granted with these ticks. A proposal from before grouping ticks it on its own. */
export function allowedBy(operation: ProposedOperation, ticked: ReadonlySet<string>): boolean {
  return !operation.unsafe || ticked.has(operation.tick ?? unsafeKey.operation(operation.serviceId, operation.operation));
}

/** What the operator didn't tick, as a sentence to add to the outcome, or nothing: operations by name, then other grants. */
export function leftOutSentence(operations: ReadonlyArray<ProposedOperation>, others: ReadonlyArray<UnsafeGrant> = []): string {
  const parts = [...(operations.length ? [callsOn(operations)] : []), ...others.map((grant) => grant.what.charAt(0).toLowerCase() + grant.what.slice(1))];
  if (!parts.length) return "";
  return ` Left out, as you didn't tick ${operations.length + others.length === 1 ? "it" : "them"}: ${parts.join("; ")}.`;
}

/** Whether a grant is a tick for operations, which the outcome names by operation instead. */
export function ticksOperations(grant: UnsafeGrant): boolean {
  return /^operations?:/.test(grant.key);
}

/**
 * The ticks for unsafe operations, one per service and kind, each naming its operations, so a code
 * host's sixty operations ask for two or three ticks rather than sixty.
 */
export function groupedGrants(
  operations: ReadonlyArray<{ service: Pick<ServiceRecord, "id" | "name" | "kind">; tool: ServiceTool }>,
  staffName: string,
): UnsafeGrant[] {
  const groups = new Map<string, { service: Pick<ServiceRecord, "id" | "name" | "kind">; group: RiskGroup; tools: ServiceTool[] }>();
  for (const { service, tool } of operations) {
    if (!operationRisk(service, tool, staffName)) continue;
    const group = riskGroup(tool);
    const key = unsafeKey.operations(service.id, group);
    const entry = groups.get(key) ?? { service, group, tools: [] };
    entry.tools.push(tool);
    groups.set(key, entry);
  }
  return [...groups].map(([key, { service, group, tools }]) => ({
    key,
    what: `${GROUP_WHAT[group]} ${service.name}: ${listed(tools.map((tool) => tool.name))}`,
    risk: groupRisk(service, group, tools, staffName),
    required: false,
  }));
}

const GROUP_WHAT: Record<RiskGroup, string> = {
  reach: "Reach others through",
  change: "Add or change things on",
  destroy: "Delete or overwrite things on",
};

function groupRisk(service: Pick<ServiceRecord, "name" | "kind">, group: RiskGroup, tools: ServiceTool[], staffName: string): string {
  const these = tools.length === 1 ? tools[0]!.name : "These";
  const they = tools.length === 1 ? "it" : "them";
  if (service.kind === "local_mcp") return `${localRisk(service)} Something ${staffName} reads could tell them what to ask of it.`;
  switch (group) {
    case "reach":
      return `${service.name} doesn't rule out that ${these === "These" ? "these" : these} ${tools.length === 1 ? "reaches" : "reach"} parties other than itself. Something ${staffName} reads could make them send what they know there.`;
    case "change":
      return `${these} ${tools.length === 1 ? "changes" : "change"} things outside the office, though ${service.name} says not by deleting or overwriting. Something ${staffName} reads could tell them to use ${they}, such as to send what they know to anyone.`;
    case "destroy": {
      const unlabeled = tools.filter((tool) => labelOf(tool) === "unlabeled").map((tool) => tool.name);
      const unsaid = unlabeled.length ? ` ${service.name} doesn't say what ${listed(unlabeled)} ${unlabeled.length === 1 ? "does" : "do"}, so ${unlabeled.length === 1 ? "it counts" : "they count"} as this.` : "";
      return `${these} can delete or overwrite things outside the office.${unsaid} Something ${staffName} reads could tell them to use ${they}.`;
    }
  }
}

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

/**
 * Operations as a phrase, grouped by service, such as "search_messages and send_message (unsafe, as
 * you ticked) on Work mail". A code host grants eight at once, and naming the service each time hid them.
 */
export function callsOn(operations: ReadonlyArray<{ operation: string; serviceName: string; unsafe?: unknown }>, options: { markUnsafe?: boolean } = {}): string {
  const byService = new Map<string, string[]>();
  for (const operation of operations) {
    const names = byService.get(operation.serviceName) ?? [];
    names.push(`${operation.operation}${options.markUnsafe && operation.unsafe ? " (unsafe, as you ticked)" : ""}`);
    byService.set(operation.serviceName, names);
  }
  return [...byService].map(([service, names]) => `${listed(names)} on ${service}`).join("; ");
}

function listed(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
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

type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
const JSON_TYPES: readonly string[] = ["string", "number", "integer", "boolean", "array", "object", "null"];

/**
 * What is wrong with arguments for a tool, checked against its input schema before the call: a
 * required property missing, one the schema doesn't allow, a value of the wrong type, or one outside
 * its list. Only what the schema says plainly is checked; anything it leaves open passes, and the
 * service has the last word. `link_id` is AiHub's to set, so it is never asked for.
 */
export function argumentProblems(schema: unknown, args: Record<string, unknown>): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const object = schema as { properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown };
  const properties = typeof object.properties === "object" && object.properties !== null ? object.properties : {};
  const problems: string[] = [];
  const required = Array.isArray(object.required) ? object.required.filter((name): name is string => typeof name === "string") : [];
  for (const name of required) if (name !== "link_id" && args[name] === undefined) problems.push(`${name} is required`);
  for (const [name, value] of Object.entries(args)) {
    if (name === "link_id" || value === undefined) continue;
    const property = properties[name];
    if (property === undefined) {
      if (object.additionalProperties === false) problems.push(`${name} isn't one of its arguments`);
      continue;
    }
    const problem = valueProblem(property, value);
    if (problem) problems.push(`${name} ${problem}`);
  }
  return problems;
}

function valueProblem(property: unknown, value: unknown): string | null {
  if (typeof property !== "object" || property === null) return null;
  const { type, enum: allowed } = property as { type?: unknown; enum?: unknown };
  if (Array.isArray(allowed) && allowed.length && !allowed.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `must be one of ${allowed.map((option) => JSON.stringify(option)).join(", ")}`;
  }
  const types = (Array.isArray(type) ? type : [type]).filter((candidate): candidate is JsonType => typeof candidate === "string" && JSON_TYPES.includes(candidate));
  if (!types.length || types.some((candidate) => fits(candidate, value))) return null;
  return `must be ${types.map(typeName).join(" or ")}, not ${kindOf(value)}`;
}

const TYPE_NAMES: Record<JsonType, string> = {
  string: "a string",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  null: "null",
};

function typeName(type: JsonType): string {
  return TYPE_NAMES[type];
}

function fits(type: JsonType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
  }
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "number") return Number.isInteger(value) ? "a whole number" : "a number";
  if (typeof value === "boolean") return String(value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** A tool's declared output, cut short, so the Chief of Staff can write a mapping. */
export function describeOutput(schema: unknown): string {
  if (!schema) return "not declared";
  const text = JSON.stringify(schema);
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}
