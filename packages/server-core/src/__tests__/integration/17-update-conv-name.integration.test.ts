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

describe("Update Conversation Name", () => {
  it("conversation rename broadcasts update event and persists", async () => {
    const group = await setupAgentGroup(3, {
      groupName: "Old Name",
    });
    const [alice, bob, eve] = group.agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];
    const conversationId = group.conversationId!;

    // Set up event waiters on Bob and Eve BEFORE the update
      const bobUpdatedPromise = bob.client.waitForEvent(
        "conversations/updated",
      );
      const eveUpdatedPromise = eve.client.waitForEvent(
        "conversations/updated",
      );

      const updateResult = (await alice.client.rpc("conversations/update", {
        conversationId,
        name: "New Name",
      })) as { conversation: { id: string; name: string } };

      expect(updateResult.conversation.name).toBe("New Name");

      const bobUpdated = await bobUpdatedPromise;
      const eveUpdated = await eveUpdatedPromise;

      expect(
        (bobUpdated.data as { conversation: { name: string } }).conversation
          .name,
      ).toBe("New Name");
      expect(
        (eveUpdated.data as { conversation: { name: string } }).conversation
          .name,
      ).toBe("New Name");

      // Verify persistence via conversations/list
      const listResult = (await alice.client.rpc("conversations/list", {})) as {
        conversations: Array<{ id: string; name?: string }>;
      };
      const found = listResult.conversations.find(
        (c) => c.id === conversationId,
      );
      expect(found).toBeDefined();
      expect(found!.name).toBe("New Name");
  });
});
