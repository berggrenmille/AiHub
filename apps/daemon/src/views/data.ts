import type { Agent, Run } from "@aihub/shared";
import { DATA_TOOLS, isDataTool, type DataToolInput } from "@aihub/views";
import { z } from "zod";
import { InvalidRequestError } from "../errors.ts";
import type { Office } from "../office.ts";
import { readCalendarFile } from "../sources/ics.ts";
import { readSource } from "../sources/collect.ts";
import { addDays, localDate, TIMEZONE, zonedInstant } from "../time.ts";

// What a dashboard fetches (DESIGN.md › Views): the read-only data tools from @aihub/views, answered
// from the office's records for the operator's page. Nothing here changes anything.

const DAY_MS = 86_400_000;

export async function answerData(office: Office, tool: string, args: unknown, now = new Date()): Promise<unknown> {
  if (!isDataTool(tool)) throw new InvalidRequestError(`There is no data tool "${tool}".`);
  const parsed = (DATA_TOOLS[tool].input as z.ZodType).safeParse(args ?? {});
  if (!parsed.success) throw new InvalidRequestError(`Invalid arguments for ${tool}: ${z.prettifyError(parsed.error)}`);
  const data = new OfficeData(office, now);
  switch (tool) {
    case "office_items":
      return data.items(parsed.data as DataToolInput<"office_items">);
    case "office_runs":
      return data.runs(parsed.data as DataToolInput<"office_runs">);
    case "office_usage":
      return data.usage(parsed.data as DataToolInput<"office_usage">);
    case "office_staff":
      return data.staff();
    case "office_assignments":
      return data.assignments(parsed.data as DataToolInput<"office_assignments">);
    case "source_records":
      return data.source(parsed.data as DataToolInput<"source_records">);
  }
}

class OfficeData {
  private readonly agents: Agent[];

  constructor(
    private readonly office: Office,
    private readonly now: Date,
  ) {
    this.agents = office.store.listAgents();
  }

  items(input: DataToolInput<"office_items">) {
    const { store } = this.office;
    const responsibilities = new Map(store.listResponsibilities().map((duty) => [duty.id, duty]));
    const owner = input.staff ? this.idOf(input.staff) : null;
    const items = store.queryItems({
      responsibilityIds: owner ? [...responsibilities.values()].filter((duty) => duty.ownerId === owner).map((duty) => duty.id) : undefined,
      states: input.states ?? ["new", "open"],
      since: input.days ? this.daysAgo(input.days) : undefined,
      needsOperator: input.needsOperator,
      limit: input.limit ?? 100,
    });
    return {
      rows: items.map((item) => {
        const duty = responsibilities.get(item.responsibilityId);
        return {
          id: item.id,
          title: item.title,
          detail: item.detail,
          urgency: item.urgency,
          needsOperator: item.needsOperator,
          state: item.state,
          staff: duty ? this.nameOf(duty.ownerId) : "",
          responsibility: duty?.title ?? "",
          firstSeenAt: item.firstSeenAt,
          updatedAt: item.updatedAt,
          resolution: item.resolution,
        };
      }),
    };
  }

  runs(input: DataToolInput<"office_runs">) {
    const runs = this.office.store.queryRuns({
      agentId: input.staff ? this.idOf(input.staff) : undefined,
      kind: input.kind,
      since: this.daysAgo(input.days ?? 7),
      limit: input.limit ?? 200,
    });
    return { rows: runs.map((run) => this.runRow(run)) };
  }

  usage(input: DataToolInput<"office_usage">) {
    const days = input.days ?? 14;
    const today = localDate(this.now, TIMEZONE);
    const first = addDays(today, -(days - 1));
    const runs = this.office.store.queryRuns({ since: zonedInstant(first, "00:00", TIMEZONE).toISOString(), limit: 1_000_000 });
    const byDay = new Map<string, { day: string; runs: number; turns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }>();
    for (let index = 0; index < days; index++) {
      const day = addDays(first, index);
      byDay.set(day, { day, runs: 0, turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    }
    for (const run of runs) {
      const row = byDay.get(localDate(new Date(run.queuedAt), TIMEZONE));
      if (!row) continue;
      row.runs++;
      row.turns += run.turns;
      row.inputTokens += run.usage.inputTokens;
      row.cachedInputTokens += run.usage.cachedInputTokens;
      row.outputTokens += run.usage.outputTokens;
    }
    return { rows: [...byDay.values()] };
  }

  staff() {
    const { store } = this.office;
    return {
      rows: this.agents.map((agent) => ({
        name: agent.name,
        title: agent.title,
        role: agent.role,
        manager: agent.managerId ? this.nameOf(agent.managerId) : null,
        responsibility: store.activeResponsibilityOf(agent.id)?.title ?? null,
        state: agent.state,
        sources: store.connectionsOf(agent.id).map((connection) => connection.label),
        webSearch: agent.web !== null,
        model: agent.model ? `${agent.model}${agent.effort ? `, ${agent.effort} reasoning` : ""}` : "office default",
        experience: agent.experience,
      })),
    };
  }

  assignments(input: DataToolInput<"office_assignments">) {
    const who = input.staff ? this.idOf(input.staff) : null;
    const assignments = this.office.store
      .assignmentsSince(this.daysAgo(input.days ?? 30))
      .filter((assignment) => !who || assignment.requesterId === who || assignment.ownerId === who)
      .slice(0, input.limit ?? 100);
    return {
      rows: assignments.map((assignment) => ({
        id: assignment.id,
        kind: assignment.kind,
        title: assignment.title,
        requester: assignment.requesterName,
        owner: assignment.ownerName,
        status: assignment.status,
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
        result: assignment.result,
      })),
    };
  }

  /** Reads a source now, as staff do. A calendar gives its events with their times, for charts and timelines. */
  async source(input: DataToolInput<"source_records">) {
    const connection = this.office.store.listConnections().find((candidate) => candidate.label.toLowerCase() === input.source.toLowerCase());
    if (!connection) throw new InvalidRequestError(`There is no source called "${input.source}".`);
    const words = input.words?.split(/\s+/).filter(Boolean) ?? [];
    const limit = input.limit ?? 50;
    if (connection.kind === "ics_file") {
      if (!connection.path.trim()) throw new InvalidRequestError(`No file is chosen for ${connection.label}.`);
      const from = input.from ?? localDate(this.now, TIMEZONE);
      const days = input.days ?? 7;
      const window = { from: zonedInstant(from, "00:00", TIMEZONE), to: zonedInstant(addDays(from, days), "00:00", TIMEZONE) };
      const all = readCalendarFile(connection.path, window).filter((record) => {
        const text = [record.title, record.location, record.description].filter(Boolean).join("\n").toLowerCase();
        return words.every((word) => text.includes(word.toLowerCase()));
      });
      const events = all.slice(0, limit).map((record) => ({
        title: record.title,
        start: record.start,
        end: record.end,
        allDay: record.allDay,
        location: record.location,
        status: record.status,
      }));
      return { summary: `${connection.label}: ${events.length} of ${all.length} events from ${from}, ${days} days.`, events };
    }
    const reading = await readSource(connection, { from: input.from, days: input.days ?? 7, words, limit }, this.office.sourceContext(this.now));
    const records = (reading.data as { records?: unknown[] } | null)?.records ?? [];
    return { summary: reading.summary, records };
  }

  private runRow(run: Run) {
    return {
      id: run.id,
      staff: this.nameOf(run.agentId),
      kind: run.kind,
      title: run.title,
      state: run.state,
      queuedAt: run.queuedAt,
      finishedAt: run.finishedAt,
      turns: run.turns,
      inputTokens: run.usage.inputTokens,
      cachedInputTokens: run.usage.cachedInputTokens,
      outputTokens: run.usage.outputTokens,
      model: run.model,
      effort: run.effort,
      error: run.error,
    };
  }

  private daysAgo(days: number): string {
    return new Date(this.now.getTime() - days * DAY_MS).toISOString();
  }

  private idOf(name: string): string {
    const agent = this.agents.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!agent) throw new InvalidRequestError(`Nobody on staff is called ${name}.`);
    return agent.id;
  }

  private nameOf(agentId: string): string {
    return this.agents.find((agent) => agent.id === agentId)?.name ?? this.office.store.getAgent(agentId)?.name ?? agentId;
  }
}
