import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
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
  it.live("conversation rename broadcasts update event and persists", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(3, {
        groupName: "Old Name",
      });
      const [alice, bob, eve] = group.agents as [
        ConnectedAgent,
        ConnectedAgent,
        ConnectedAgent,
      ];
      const conversationId = group.conversationId!;

      // Set up event waiters on Bob and Eve BEFORE the update

      const updateResult = (yield* alice.client.rpc("conversations/update", {
        conversationId,
        name: "New Name",
      })) as { conversation: { id: string; name: string } };

      expect(updateResult.conversation.name).toBe("New Name");

      const bobUpdated = yield* bob.client.waitForEvent(
        "conversations/updated",
      );
      const eveUpdated = yield* eve.client.waitForEvent(
        "conversations/updated",
      );

      expect(
        (bobUpdated.data as { conversation: { name: string } }).conversation
          .name,
      ).toBe("New Name");
      expect(
        (eveUpdated.data as { conversation: { name: string } }).conversation
          .name,
      ).toBe("New Name");

      // Verify persistence via conversations/list
      const listResult = (yield* alice.client.rpc(
        "conversations/list",
        {},
      )) as {
        conversations: Array<{ id: string; name?: string }>;
      };
      const found = listResult.conversations.find(
        (c) => c.id === conversationId,
      );
      expect(found).toBeDefined();
      expect(found!.name).toBe("New Name");
    }),
  );
});
