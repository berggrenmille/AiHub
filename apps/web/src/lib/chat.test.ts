import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, ChatMessage, Conversation } from "@aihub/shared";
import { chatName, chatPartner, chatScope, chatsOf, shownConversation, unreadCounts } from "./chat.ts";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
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

const chiefChat: Conversation = { id: "chief-of-staff", agentId: "chief", title: "Chief of Staff", topic: false, createdAt: "2026-11-01T08:00:00.000Z" };
const inesChat: Conversation = { id: "chat-ines", agentId: "ines", title: "Ines", topic: false, createdAt: "2026-11-01T08:00:00.000Z" };

describe("chat drawer", () => {
  it("shows the chat the operator opened, else the Chief of Staff's", () => {
    const conversations = [chiefChat, inesChat];
    assert.equal(shownConversation(conversations, "chief", "chat-ines"), inesChat);
    assert.equal(shownConversation(conversations, "chief", null), chiefChat);
    assert.equal(shownConversation(conversations, "chief", "chat-gone"), chiefChat);
    assert.equal(shownConversation([inesChat], "chief", null), null);
    assert.equal(shownConversation(conversations, null, null), null);
    const topic: Conversation = { ...chiefChat, id: "topic-1", title: "Travel", topic: true, createdAt: "2026-10-01T08:00:00.000Z" };
    assert.equal(shownConversation([topic, ...conversations], "chief", null), chiefChat, "the general chat, not a topic");
  });

  it("finds who a chat is with, also after they have left", () => {
    const ines = agent("ines", { name: "Ines", connectionIds: ["conn-1"] });
    assert.deepEqual(chatPartner(inesChat, [ines], new Map()), { agent: ines, present: true });

    const working = agent("ada", { name: "Ada", role: "worker", state: "working" });
    const adaChat: Conversation = { id: "chat-ada", agentId: "ada", title: "Ada", topic: false, createdAt: "2026-11-01T08:00:00.000Z" };
    const left = chatPartner(adaChat, [ines], new Map([["ada", working]]));
    assert.equal(left.present, false);
    assert.equal(left.agent.name, "Ada");
    assert.equal(left.agent.state, "idle", "someone who left isn't shown at work");

    const unknown = chatPartner(adaChat, [], new Map());
    assert.equal(unknown.present, false);
    assert.equal(unknown.agent.name, "Ada");
    assert.equal(unknown.agent.avatar, "Ada");
  });

  it("says staff answer from their own sources, except the Chief of Staff", () => {
    assert.equal(chatScope(agent("chief", { role: "chief_of_staff" })), null);
    assert.equal(chatScope(agent("ines", { name: "Ines", connectionIds: ["conn-1"] })), "Answers come from Ines's own sources and notes.");
    assert.match(chatScope(agent("ada", { name: "Ada", role: "worker" })) ?? "", /^Ada reads no sources/);
  });
});

describe("Topics", () => {
  const topic = (id: string, title: string, createdAt: string): Conversation => ({ id, agentId: "chief", title, topic: true, createdAt });
  const message = (id: number, conversationId: string, author: ChatMessage["author"], createdAt = "2026-11-08T09:00:00.000Z"): ChatMessage => ({
    id,
    conversationId,
    author,
    agentId: author === "agent" ? "chief" : null,
    kind: "chat",
    body: "",
    runId: null,
    refId: null,
    createdAt,
  });

  it("lists someone's general chat first, then topics, the most recently active first", () => {
    const old = topic("topic-old", "Travel", "2026-11-02T08:00:00.000Z");
    const quiet = topic("topic-quiet", "Taxes", "2026-11-05T08:00:00.000Z");
    const messages = { "topic-old": [message(1, "topic-old", "operator", "2026-11-08T10:00:00.000Z")] };
    assert.deepEqual(
      chatsOf("chief", [quiet, chiefChat, inesChat, old], messages).map((conversation) => conversation.id),
      ["chief-of-staff", "topic-old", "topic-quiet"],
    );
    assert.deepEqual([chatName(chiefChat), chatName(old)], ["General", "Travel"]);
  });

  it("counts what staff said since the operator last looked, except in the chat on screen", () => {
    const travel = topic("topic-travel", "Travel", "2026-11-02T08:00:00.000Z");
    const messages = {
      "chief-of-staff": [message(1, "chief-of-staff", "agent"), message(2, "chief-of-staff", "operator"), message(3, "chief-of-staff", "agent")],
      "topic-travel": [message(4, "topic-travel", "agent")],
    };
    const seen = new Map([["chief-of-staff", 1]]);
    assert.deepEqual([...unreadCounts([chiefChat, travel, inesChat], messages, seen, null)], [["chief-of-staff", 1], ["topic-travel", 1]]);
    assert.deepEqual([...unreadCounts([chiefChat, travel], messages, seen, "topic-travel")], [["chief-of-staff", 1]]);
  });
});
