import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentGroup,
} from "./helpers.js";
import type { ConnectedAgent } from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Group Creation Events", () => {
  it("group creation notifies all participants with conversations/created event", async () => {
    const { agents } = await setupAgentGroup(3);
    const [alice, bob, eve] = agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];

    // Set up event waiters on Bob and Eve BEFORE creating the group
      const bobCreatedPromise = bob.client.waitForEvent(
        "conversations/created",
      );
      const eveCreatedPromise = eve.client.waitForEvent(
        "conversations/created",
      );

      const conv = (await alice.client.rpc("conversations/create", {
        type: "group",
        name: "Eval Group",
        participants: [
          { type: "agent", id: bob.agentId },
          { type: "agent", id: eve.agentId },
        ],
      })) as {
        conversation: { id: string; type: string; name: string };
      };

      expect(conv.conversation.type).toBe("group");
      expect(conv.conversation.name).toBe("Eval Group");

      const bobCreated = await bobCreatedPromise;
      const eveCreated = await eveCreatedPromise;

      const bobConv = (bobCreated.data as { conversation: { id: string } })
        .conversation;
      const eveConv = (eveCreated.data as { conversation: { id: string } })
        .conversation;

      expect(bobConv.id).toBe(conv.conversation.id);
      expect(eveConv.id).toBe(conv.conversation.id);
  });
});
