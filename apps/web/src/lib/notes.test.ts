import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, NoteSummary } from "@aihub/shared";
import { backlinksOf, linkTitle, noteFolders, noteGraph, resolveWikilink } from "./notes.ts";

function note(path: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return { path, title, ownerId: null, kind: "topic", provenance: "aihub", links: [], updatedAt: "2026-11-07T16:00:00.000Z", ...overrides };
}

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    title: "Supervisor",
    description: "",
    workingStyle: "",
    avatar: id,
    hiredAt: "2026-11-07T16:00:00.000Z",
    experience: 0,
    connectionIds: [],
    role: "supervisor",
    managerId: "chief-of-staff",
    profile: "conversation",
    state: "idle",
  };
}

const officeAnna = note("Office/Anna.md", { kind: "office" });
const elinAnna = note("Staff/work-schedule/Anna.md", { ownerId: "work-schedule", provenance: "source_data" });
const oskarAnna = note("Staff/work-inbox/Anna.md", { ownerId: "work-inbox" });
const elinJournal = note("Staff/work-schedule/Journal/2026-11-07.md", { ownerId: "work-schedule", kind: "journal", links: ["Anna"] });
const elinProfile = note("Staff/work-schedule/Elin.md", { ownerId: "work-schedule", kind: "profile", links: ["Q4 planning", "Missing"] });
const q4 = note("Staff/work-schedule/Q4 planning.md", { ownerId: "work-schedule", links: ["Anna", "Elin"] });
const all = [officeAnna, elinAnna, oskarAnna, elinJournal, elinProfile, q4];

describe("wikilinks", () => {
  it("takes the title from a link's last segment, without heading, alias or extension", () => {
    assert.equal(linkTitle("Staff/work-schedule/Anna.md#Notes|her"), "Anna");
    assert.equal(linkTitle("Q4 planning"), "Q4 planning");
  });

  it("resolves the same owner's note first, then the Office, then anyone's", () => {
    assert.equal(resolveWikilink("Anna", { ownerId: "work-schedule" }, all)?.path, elinAnna.path);
    assert.equal(resolveWikilink("Anna", { ownerId: "work-inbox" }, all)?.path, oskarAnna.path);
    assert.equal(resolveWikilink("Anna", { ownerId: "portfolio" }, all)?.path, officeAnna.path);
    assert.equal(resolveWikilink("Anna", null, all)?.path, officeAnna.path);
    assert.equal(resolveWikilink("Anna", { ownerId: "portfolio" }, [elinAnna, oskarAnna])?.path, oskarAnna.path, "path order among others");
  });

  it("matches titles without regard to case, and by path when given one", () => {
    assert.equal(resolveWikilink("q4 PLANNING#Agenda|plan", { ownerId: null }, all)?.path, q4.path);
    assert.equal(resolveWikilink("Staff/work-inbox/Anna", { ownerId: "work-schedule" }, all)?.path, oskarAnna.path);
    assert.equal(resolveWikilink("Nobody", null, all), null);
    assert.equal(resolveWikilink("", null, all), null);
  });

  it("prefers a topic over a journal day with the same title", () => {
    const day = note("Staff/x/Journal/Plans.md", { ownerId: "x", kind: "journal" });
    const topic = note("Staff/x/Plans.md", { ownerId: "x" });
    assert.equal(resolveWikilink("Plans", { ownerId: "x" }, [day, topic])?.path, topic.path);
  });

  it("finds backlinks that resolve to the note, not to a namesake", () => {
    assert.deepEqual(backlinksOf(elinAnna, all).map((n) => n.path).sort(), [elinJournal.path, q4.path].sort());
    assert.deepEqual(backlinksOf(officeAnna, all), []);
    assert.deepEqual(backlinksOf(elinProfile, all).map((n) => n.path), [q4.path]);
  });
});

describe("note folders and graph", () => {
  it("lists the Office first, then staff in order, then former staff", () => {
    const orphan = note("Staff/gone/Old.md", { ownerId: "gone" });
    const folders = noteFolders([...all, orphan], [agent("work-schedule", "Elin"), agent("work-inbox", "Oskar")]);
    assert.deepEqual(folders.map((f) => f.label), ["Office", "Elin", "Oskar", "gone (former staff)"]);
    const elin = folders[1]!;
    assert.deepEqual(elin.notes.map((n) => n.title), ["Elin", "Anna", "Q4 planning"], "profile first, then by title");
    assert.deepEqual(elin.journal.map((n) => n.path), [elinJournal.path]);
  });

  it("draws one edge per resolved link pair, optionally without journal days", () => {
    const graph = noteGraph(all);
    assert.equal(graph.nodes.length, all.length);
    const pairs = graph.edges.map((e) => [e.source, e.target].sort().join(" <> ")).sort();
    assert.deepEqual(pairs, [
      [elinAnna.path, elinJournal.path].sort().join(" <> "),
      [elinAnna.path, q4.path].sort().join(" <> "),
      [elinProfile.path, q4.path].sort().join(" <> "),
    ].sort());
    assert.equal(graph.nodes.find((n) => n.id === q4.path)?.degree, 2);

    const withoutJournals = noteGraph(all, { journals: false });
    assert.equal(withoutJournals.nodes.length, all.length - 1);
    assert.equal(withoutJournals.edges.length, 2);
  });
});
