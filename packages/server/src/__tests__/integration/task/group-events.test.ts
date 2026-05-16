import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentGroup,
} from "../helpers.js";
import type { ConnectedAgent } from "../helpers.js";

import {
  ConversationsCreate,
  ConversationCreatedNotificationDefinition,
} from "@moltzap/protocol";

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Group Creation Events", () => {
  it.live(
    "group creation notifies all participants with conversations/created event",
    () =>
      Effect.gen(function* () {
        const { agents } = yield* setupAgentGroup(3);
        const [alice, bob, eve] = agents as [
          ConnectedAgent,
          ConnectedAgent,
          ConnectedAgent,
        ];

        // Set up event waiters on Bob and Eve BEFORE creating the group

        const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
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

        const bobCreated = yield* bob.client.waitForNotification(
          ConversationCreatedNotificationDefinition,
        );
        const eveCreated = yield* eve.client.waitForNotification(
          ConversationCreatedNotificationDefinition,
        );

        const bobConv = (bobCreated.params as { conversation: { id: string } })
          .conversation;
        const eveConv = (eveCreated.params as { conversation: { id: string } })
          .conversation;

        expect(bobConv.id).toBe(conv.conversation.id);
        expect(eveConv.id).toBe(conv.conversation.id);
      }),
  );
});
