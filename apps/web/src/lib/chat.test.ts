import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, Conversation } from "@aihub/shared";
import { chatPartner, chatScope, shownConversation } from "./chat.ts";

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
    role: "supervisor",
    managerId: "chief",
    profile: "data",
    state: "idle",
    ...overrides,
  };
}

const chiefChat: Conversation = { id: "chief-of-staff", agentId: "chief", title: "Chief of Staff" };
const inesChat: Conversation = { id: "chat-ines", agentId: "ines", title: "Ines" };

describe("chat drawer", () => {
  it("shows the chat the operator opened, else the Chief of Staff's", () => {
    const conversations = [chiefChat, inesChat];
    assert.equal(shownConversation(conversations, "chief", "chat-ines"), inesChat);
    assert.equal(shownConversation(conversations, "chief", null), chiefChat);
    assert.equal(shownConversation(conversations, "chief", "chat-gone"), chiefChat);
    assert.equal(shownConversation([inesChat], "chief", null), null);
    assert.equal(shownConversation(conversations, null, null), null);
  });

  it("finds who a chat is with, also after they have left", () => {
    const ines = agent("ines", { name: "Ines", connectionIds: ["conn-1"] });
    assert.deepEqual(chatPartner(inesChat, [ines], new Map()), { agent: ines, present: true });

    const working = agent("ada", { name: "Ada", role: "worker", state: "working" });
    const adaChat = { id: "chat-ada", agentId: "ada", title: "Ada" };
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
