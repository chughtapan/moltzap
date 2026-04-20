import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  setupAgentPair,
} from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Scenario 34: apps/register + system/ping RPCs", () => {
  describe("system/ping", () => {
    it.live("returns an ISO8601 ts string", () =>
      Effect.gen(function* () {
        const agent = yield* registerAndConnect("alice");

        const result = (yield* agent.client.sendRpc("system/ping", {})) as {
          ts: string;
        };

        expect(typeof result.ts).toBe("string");
        expect(result.ts).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
        expect(Date.now() - Date.parse(result.ts)).toBeLessThan(60_000);
      }),
    );
  });

  describe("apps/register", () => {
    it.live("registers a valid manifest and returns the appId", () =>
      Effect.gen(function* () {
        const agent = yield* registerAndConnect("alice");

        const result = (yield* agent.client.sendRpc("apps/register", {
          manifest: {
            appId: "my-test-app",
            name: "My Test App",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
          },
        })) as { appId: string };

        expect(result.appId).toBe("my-test-app");
      }),
    );

    it.live("rejects a manifest missing required fields", () =>
      Effect.gen(function* () {
        const agent = yield* registerAndConnect("alice");

        const exit = yield* Effect.exit(
          agent.client.sendRpc("apps/register", {
            manifest: { appId: "broken" },
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );

    it.live("rejects calls missing the manifest param entirely", () =>
      Effect.gen(function* () {
        const agent = yield* registerAndConnect("alice");

        const exit = yield* Effect.exit(
          agent.client.sendRpc("apps/register", {}),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });

  describe("messages/send with replyToId only", () => {
    it.live(
      "resolves conversationId from replyToId when caller omits conversationId",
      () =>
        Effect.gen(function* () {
          const { alice, bob } = yield* setupAgentPair();

          const conv = (yield* alice.client.sendRpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: bob.agentId }],
          })) as { conversation: { id: string } };
          const conversationId = conv.conversation.id;

          const sent = (yield* alice.client.sendRpc("messages/send", {
            conversationId,
            parts: [{ type: "text", text: "question" }],
          })) as { message: { id: string } };

          const replied = (yield* bob.client.sendRpc("messages/send", {
            replyToId: sent.message.id,
            parts: [{ type: "text", text: "answer" }],
          })) as {
            message: { conversationId: string; replyToId?: string };
          };

          expect(replied.message.conversationId).toBe(conversationId);
          expect(replied.message.replyToId).toBe(sent.message.id);
        }),
    );

    it.live("rejects when replyToId points to an unknown message", () =>
      Effect.gen(function* () {
        const agent = yield* registerAndConnect("alice");
        const unknownId = "00000000-0000-0000-0000-000000000000";

        const exit = yield* Effect.exit(
          agent.client.sendRpc("messages/send", {
            replyToId: unknownId,
            parts: [{ type: "text", text: "orphan" }],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });
});
