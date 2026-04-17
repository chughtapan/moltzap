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

        const conv = (yield* alice.client.rpc("conversations/create", {
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

        const bobCreated = yield* bob.client.waitForEvent(
          "conversations/created",
        );
        const eveCreated = yield* eve.client.waitForEvent(
          "conversations/created",
        );

        const bobConv = (bobCreated.data as { conversation: { id: string } })
          .conversation;
        const eveConv = (eveCreated.data as { conversation: { id: string } })
          .conversation;

        expect(bobConv.id).toBe(conv.conversation.id);
        expect(eveConv.id).toBe(conv.conversation.id);
      }),
  );
});
