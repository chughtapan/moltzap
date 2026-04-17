import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
} from "./helpers.js";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  _baseUrl = server.baseUrl;
  _wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Scenario 28: conversations/get with UUID columns", () => {
  it.live("returns conversation details and participants for a DM", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-get");
      const bob = yield* registerAndConnect("bob-get");

      // Create a DM
      const conv = (yield* alice.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string; type: string } };

      const conversationId = conv.conversation.id;

      // Get the conversation — this exercises the LEFT JOIN with UUID columns
      const result = (yield* alice.client.sendRpc("conversations/get", {
        conversationId,
      })) as {
        conversation: { id: string; type: string; name: string | null };
        participants: Array<{
          participant: { type: string; id: string };
          role: string;
        }>;
      };

      expect(result.conversation.id).toBe(conversationId);
      expect(result.conversation.type).toBe("dm");
      expect(result.participants).toHaveLength(2);

      const participantIds = result.participants.map((p) => p.participant.id);
      expect(participantIds).toContain(alice.agentId);
      expect(participantIds).toContain(bob.agentId);
    }),
  );

  it.live("returns conversation details for a group with agent names", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-grp-get");
      const bob = yield* registerAndConnect("bob-grp-get");

      // Create a group
      const conv = (yield* alice.client.sendRpc("conversations/create", {
        type: "group",
        name: "Test Group",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string; type: string; name: string } };

      const conversationId = conv.conversation.id;

      // Get the conversation — the LEFT JOIN on agents table must work with UUID columns
      const result = (yield* alice.client.sendRpc("conversations/get", {
        conversationId,
      })) as {
        conversation: { id: string; type: string; name: string };
        participants: Array<{
          participant: { type: string; id: string };
          role: string;
          agentName?: string;
        }>;
      };

      expect(result.conversation.id).toBe(conversationId);
      expect(result.conversation.type).toBe("group");
      expect(result.conversation.name).toBe("Test Group");
      expect(result.participants).toHaveLength(2);
    }),
  );
});
