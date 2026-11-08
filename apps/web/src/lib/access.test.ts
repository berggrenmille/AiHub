import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, Service, ServiceGrant, SourceConnection, UnsafeGrant } from "@aihub/shared";
import { describeOperation, grantsOn, holdersOf, inUse, listedServices, missingTicks, serviceOf, sortedOperations, unsafeRows } from "./access.ts";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    title: "",
    description: "",
    workingStyle: "",
    avatar: id,
    hiredAt: "2026-11-07T16:00:00.000Z",
    experience: 0,
    connectionIds: [],
    web: null,
    model: null,
    effort: null,
    role: "supervisor",
    managerId: "chief",
    profile: "data",
    state: "idle",
    ...overrides,
  };
}

function service(id: string, overrides: Partial<Service> = {}): Service {
  return {
    id,
    kind: "remote_mcp",
    name: id,
    where: `https://${id}.example.test/mcp`,
    account: null,
    status: "connected",
    detail: null,
    operations: [],
    reason: null,
    proposedBy: "chief",
    unsafe: null,
    connectUrl: null,
    checkedAt: null,
    createdAt: "2026-11-07T16:00:00.000Z",
    ...overrides,
  };
}

function grant(id: number, agentId: string, serviceId: string, operation: string, unsafe: string | null = null): ServiceGrant {
  return { id, agentId, serviceId, operation, unsafe, grantedAt: "2026-11-07T16:00:00.000Z", lastUsedAt: null };
}

const local: UnsafeGrant = { key: "service:files", what: "Files, a program on this PC", risk: "It runs outside the sandbox.", required: true };

describe("access", () => {
  it("says what an operation does, counting an unlabeled one as changing things", () => {
    assert.equal(describeOperation({ label: "reads", openWorld: false }), "Reads");
    assert.equal(describeOperation({ label: "reads", openWorld: true }), "Reads, may reach others");
    assert.equal(describeOperation({ label: "changes", openWorld: true }), "Changes things");
    assert.equal(describeOperation({ label: "unlabeled", openWorld: true }), "Unlabeled, counts as changing things");
    const operations = [
      { name: "update_issue", label: "changes", openWorld: true },
      { name: "mystery", label: "unlabeled", openWorld: false },
      { name: "search_issues", label: "reads", openWorld: false },
      { name: "fetch", label: "reads", openWorld: true },
      { name: "fetch_issue", label: "reads", openWorld: false },
    ] as const;
    assert.deepEqual(
      sortedOperations(operations).map((operation) => operation.name),
      ["fetch_issue", "search_issues", "fetch", "update_issue", "mystery"],
      "reads first, then what may reach others, changes, or says nothing, each by name",
    );
  });

  it("lists services waiting or in use, the unsafe ones first", () => {
    const services = [
      service("mail"),
      service("drive", { status: "declined" }),
      service("files", { kind: "local_mcp", unsafe: local }),
      service("calendar", { status: "signed_out" }),
      service("old", { status: "removed" }),
      service("notes", { status: "proposed" }),
    ];
    assert.deepEqual(
      listedServices(services).map((one) => one.id),
      ["files", "calendar", "mail", "notes"],
    );
    assert.deepEqual(
      services.filter(inUse).map((one) => one.id),
      ["mail", "files", "calendar"],
    );
  });

  it("gathers every unsafe grant in force: operations staff hold, programs on this PC, and live search", () => {
    const services = [service("mail", { name: "Work mail" }), service("files", { kind: "local_mcp", unsafe: local }), service("tools", { kind: "local_mcp", status: "proposed", unsafe: { ...local, key: "service:tools" } })];
    const grants = [
      grant(1, "ines", "mail", "search_messages"),
      grant(2, "ines", "mail", "send_message", "Ines could send what they know to anyone."),
      grant(3, "gone", "mail", "send_message", "Left the office."),
    ];
    const agents = [agent("ines", { web: { sites: [], live: true } }), agent("nils", { web: { sites: [] } })];
    assert.deepEqual(
      unsafeRows(services, grants, agents).map((row) => [row.kind, row.what, row.agentId, row.grantId ?? row.serviceId ?? null]),
      [
        ["operation", "send_message on Work mail", "ines", 2],
        ["service", "Files, a program on this PC", null, "files"],
        ["web", "Live web search", "ines", null],
      ],
      "not a proposed program, nor a grant held by someone who left",
    );
  });

  it("finds who holds a source, what is granted on a service, and the service a source reads", () => {
    const inbox: SourceConnection = {
      id: "c1",
      kind: "service",
      label: "Inbox",
      path: "",
      pattern: null,
      reader: null,
      service: { serviceId: "mail", operation: "list_messages", arguments: {}, mapping: { list: "messages", key: "id", title: "subject" } },
      status: "connected",
      detail: null,
      verifiedAt: null,
    };
    const folder: SourceConnection = { ...inbox, id: "c2", kind: "folder", service: null };
    const agents = [agent("ines", { connectionIds: ["c1"] }), agent("nils", { connectionIds: ["c2"] })];
    const services = [service("mail"), service("drive")];
    assert.deepEqual(holdersOf(inbox, agents).map((one) => one.id), ["ines"]);
    assert.deepEqual(grantsOn(services[0]!, [grant(1, "ines", "mail", "search_messages"), grant(2, "nils", "drive", "list_files")]).map((one) => one.id), [1]);
    assert.equal(serviceOf(inbox, services)?.id, "mail");
    assert.equal(serviceOf(folder, services), null);
    assert.equal(serviceOf(inbox, [services[1]!]), null, "a removed service isn't on file");
  });

  it("holds approval only for the required ticks", () => {
    const optional: UnsafeGrant = { key: "operation:mail/send_message", what: "send_message on Work mail", risk: "", required: false };
    assert.deepEqual(missingTicks([local, optional], new Set()), [local]);
    assert.deepEqual(missingTicks([local, optional], new Set(["service:files"])), []);
  });
});
