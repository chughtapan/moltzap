import assert from "node:assert/strict";
import test from "node:test";
import { createMoltZapConversationBootstrap } from "./bootstrap.mjs";

test("concurrent first messages share wiring and each replay", async () => {
  let wiring;
  let creates = 0;
  const replays = [];
  const handler = createMoltZapConversationBootstrap({
    createMessagingGroupAgent: async (value) => {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      wiring = value;
    },
    getMessagingGroupAgentByPair: async () => wiring,
    getSessionsByAgentGroup: async () => [
      { id: "active", status: "active" },
      { id: "closed", status: "closed" },
    ],
    renameDestination: async () => {},
    routeInbound: async (event) => replays.push(event.message.id),
    updateMessagingGroup: async () => {},
    updateMessagingGroupAgent: async () => {},
    writeDestinations: async () => {},
  });
  const messagingGroup = {
    id: "mg-1",
    platform_id: "group:alpha",
  };

  const results = await Promise.all([
    handler(messagingGroup, { message: { id: "one" } }),
    handler(messagingGroup, { message: { id: "two" } }),
  ]);

  assert.deepEqual(results, ["handled", "handled"]);
  assert.equal(creates, 1);
  assert.deepEqual(replays.sort(), ["one", "two"]);
  assert.equal(wiring.session_mode, "agent-shared");
});

test("existing wiring is reused and corrected to agent-shared", async () => {
  const existing = { id: "mga-1", session_mode: "shared" };
  const handler = createMoltZapConversationBootstrap({
    createMessagingGroupAgent: async () => assert.fail("created a duplicate"),
    getMessagingGroupAgentByPair: async () => existing,
    getSessionsByAgentGroup: async () => [],
    renameDestination: async () => {},
    routeInbound: async () => {},
    updateMessagingGroup: async () => {},
    updateMessagingGroupAgent: async (_id, patch) =>
      Object.assign(existing, patch),
    writeDestinations: async () => {},
  });

  assert.equal(
    await handler(
      { id: "mg-1", platform_id: "agent:alpha" },
      { message: { id: "one" } },
    ),
    "handled",
  );
  assert.equal(existing.session_mode, "agent-shared");
});
