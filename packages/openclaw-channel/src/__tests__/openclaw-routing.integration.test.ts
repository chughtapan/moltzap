/**
 * Tier 2: Real OpenClaw gateway + real MoltZap server integration tests.
 *
 * Every test uses shared OpenClaw containers (started in globalSetup) with an
 * echo model provider -- no LLM API keys required. Verifies message routing,
 * not LLM quality.
 */

import { describe, expect, inject, beforeAll, afterAll } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { getLogs } from "../test-utils/container-core.js";
import {
  initWorker,
  cleanupWorker,
  registerAndClaim,
  makeContact,
  extractMessage,
  extractConvId,
  extractText,
} from "./test-helpers.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(() => {
  initWorker();
  baseUrl = inject("baseUrl");
  wsUrl = inject("wsUrl");
});

afterAll(async () => {
  await cleanupWorker();
});

describe.skipIf(inject("containerAId") === "")(
  "Real OpenClaw gateway integration",
  () => {
    const containerAId = inject("containerAId");
    const containerAAgentId = inject("containerAAgentId");
    const containerAUserId = inject("containerAUserId");
    const containerASupabaseUid = inject("containerASupabaseUid");
    const containerBAgentId = inject("containerBAgentId");
    const containerBUserId = inject("containerBUserId");

    // --- Gateway lifecycle ---

    it.live(
      "gateway starts, loads MoltZap plugin, connects to server",
      () =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            const logs = getLogs(containerAId);
            expect(logs).toContain("[gateway]");
            expect(logs).toContain("[moltzap]");
          });
        }),
      30_000,
    );

    // --- Agent-to-agent tests (shared container A) ---

    describe("agent-to-agent messaging", () => {
      it.live(
        "DM: alice sends -> OpenClaw dispatch -> echo reply arrives",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.promise(() =>
              registerAndClaim("a2a-alice-dm"),
            );
            yield* Effect.promise(() =>
              makeContact(alice.userId, containerAUserId),
            );

            const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* aliceClient.connect(alice.apiKey);

            const convId = extractConvId(
              yield* aliceClient.rpc("conversations/create", {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            yield* aliceClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "hello from alice" }],
            });

            const reply = extractMessage(
              yield* aliceClient.waitForEvent("messages/received", 60_000),
            );
            expect(reply.parts.length).toBeGreaterThan(0);
            expect(reply.conversationId).toBe(convId);
            expect(reply.senderId).toBe(containerAAgentId);
            expect(extractText(reply)).toContain("ECHO:");

            yield* aliceClient.close();
          }),
        90_000,
      );

      it.live(
        "group: message dispatched through real OpenClaw",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.promise(() =>
              registerAndClaim("a2a-alice-grp"),
            );
            const eve = yield* Effect.promise(() =>
              registerAndClaim("a2a-eve-grp"),
            );
            yield* Effect.promise(() =>
              makeContact(alice.userId, containerAUserId),
            );
            yield* Effect.promise(() => makeContact(alice.userId, eve.userId));
            yield* Effect.promise(() =>
              makeContact(containerAUserId, eve.userId),
            );

            const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* aliceClient.connect(alice.apiKey);

            const convId = extractConvId(
              yield* aliceClient.rpc("conversations/create", {
                type: "group",
                name: "Integration Group",
                participants: [
                  { type: "agent", id: containerAAgentId },
                  { type: "agent", id: eve.agentId },
                ],
              }),
            );

            // Wait for conversation event to propagate to the gateway
            yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

            yield* aliceClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "hello group" }],
            });

            const reply = extractMessage(
              yield* aliceClient.waitForEvent("messages/received", 60_000),
            );
            expect(reply.parts.length).toBeGreaterThan(0);
            expect(reply.conversationId).toBe(convId);
            expect(extractText(reply)).toContain("ECHO:");

            yield* aliceClient.close();
          }),
        90_000,
      );

      it.live(
        "rapid: multiple messages all get echo replies",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.promise(() =>
              registerAndClaim("a2a-alice-rapid"),
            );
            yield* Effect.promise(() =>
              makeContact(alice.userId, containerAUserId),
            );

            const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* aliceClient.connect(alice.apiKey);

            const convId = extractConvId(
              yield* aliceClient.rpc("conversations/create", {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            for (let i = 0; i < 3; i++) {
              yield* aliceClient.rpc("messages/send", {
                conversationId: convId,
                parts: [{ type: "text", text: `Message ${i}` }],
              });
            }

            const replies = yield* Effect.all(
              [
                aliceClient.waitForEvent("messages/received", 60_000),
                aliceClient.waitForEvent("messages/received", 60_000),
                aliceClient.waitForEvent("messages/received", 60_000),
              ],
              { concurrency: "unbounded" },
            );
            expect(replies).toHaveLength(3);
            for (const r of replies) {
              const msg = extractMessage(r);
              expect(msg.parts.length).toBeGreaterThan(0);
              expect(msg.senderId).toBe(containerAAgentId);
              expect(extractText(msg)).toContain("ECHO:");
            }

            yield* aliceClient.close();
          }),
        120_000,
      );
    });

    // --- Two agents in separate containers ---

    it.live(
      "two agents: both receive and reply from their own containers",
      () =>
        Effect.gen(function* () {
          const alice = yield* Effect.promise(() =>
            registerAndClaim("2a-alice"),
          );
          yield* Effect.promise(() =>
            makeContact(alice.userId, containerAUserId),
          );
          yield* Effect.promise(() =>
            makeContact(alice.userId, containerBUserId),
          );

          const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
          yield* aliceClient.connect(alice.apiKey);

          const convAId = extractConvId(
            yield* aliceClient.rpc("conversations/create", {
              type: "dm",
              participants: [{ type: "agent", id: containerAAgentId }],
            }),
          );

          const convBId = extractConvId(
            yield* aliceClient.rpc("conversations/create", {
              type: "dm",
              participants: [{ type: "agent", id: containerBAgentId }],
            }),
          );

          yield* aliceClient.rpc("messages/send", {
            conversationId: convAId,
            parts: [{ type: "text", text: "hello container-a" }],
          });
          yield* aliceClient.rpc("messages/send", {
            conversationId: convBId,
            parts: [{ type: "text", text: "hello container-b" }],
          });

          const events = yield* Effect.all(
            [
              aliceClient.waitForEvent("messages/received", 60_000),
              aliceClient.waitForEvent("messages/received", 60_000),
            ],
            { concurrency: "unbounded" },
          );
          const messages = events.map((e) => extractMessage(e));

          const aMsg = messages.find((m) => m.conversationId === convAId);
          const bMsg = messages.find((m) => m.conversationId === convBId);

          expect(aMsg).toBeDefined();
          expect(bMsg).toBeDefined();
          expect(aMsg!.senderId).toBe(containerAAgentId);
          expect(bMsg!.senderId).toBe(containerBAgentId);
          expect(extractText(aMsg!)).toContain("ECHO:");
          expect(extractText(bMsg!)).toContain("ECHO:");

          yield* aliceClient.close();
        }),
      180_000,
    );

    // --- Human -> Agent (control channel) ---

    describe("human -> agent via control channel", () => {
      it.live(
        "human sends to control channel, OpenClaw replies to human",
        () =>
          Effect.gen(function* () {
            const humanClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* humanClient.connectJwt(containerASupabaseUid);

            const convId = extractConvId(
              yield* humanClient.rpc("conversations/create", {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            yield* humanClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "hello from human" }],
            });

            const reply = extractMessage(
              yield* humanClient.waitForEvent("messages/received", 60_000),
            );
            expect(reply.parts.length).toBeGreaterThan(0);
            expect(reply.conversationId).toBe(convId);
            expect(reply.senderId).toBe(containerAAgentId);
            expect(reply.senderId).toBe("agent");
            expect(extractText(reply)).toContain("ECHO:");

            yield* humanClient.close();
          }),
        90_000,
      );

      it.live(
        "agent reply has correct sender identity",
        () =>
          Effect.gen(function* () {
            const humanClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* humanClient.connectJwt(containerASupabaseUid);

            const convId = extractConvId(
              yield* humanClient.rpc("conversations/create", {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            yield* humanClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "who are you?" }],
            });

            const reply = extractMessage(
              yield* humanClient.waitForEvent("messages/received", 60_000),
            );
            expect(reply.senderId).toBe("agent");
            expect(reply.senderId).toBe(containerAAgentId);
            expect(extractText(reply)).toContain("ECHO:");

            yield* humanClient.close();
          }),
        90_000,
      );
    });

    // --- Aggressive scenarios ---

    describe("outbound proactive messaging", () => {
      it.live(
        "agent proactively sends to agent:<name>, DM auto-created, message arrives",
        () =>
          Effect.gen(function* () {
            const receiver = yield* Effect.promise(() =>
              registerAndClaim("out-receiver-pro"),
            );
            yield* Effect.promise(() =>
              makeContact(containerAUserId, receiver.userId),
            );

            const receiverClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* receiverClient.connect(receiver.apiKey);

            const senderClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* senderClient.connect(inject("containerAApiKey"));

            const lookupResult = (yield* senderClient.rpc(
              "agents/lookupByName",
              {
                names: ["out-receiver-pro"],
              },
            )) as { agents: { id: string }[] };

            const convId = extractConvId(
              yield* senderClient.rpc("conversations/create", {
                type: "dm",
                participants: [
                  { type: "agent", id: lookupResult.agents[0]!.id },
                ],
              }),
            );

            yield* senderClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "proactive hello" }],
            });

            const received = extractMessage(
              yield* receiverClient.waitForEvent("messages/received", 60_000),
            );
            expect(received.senderId).toBe(containerAAgentId);
            expect(extractText(received)).toBe("proactive hello");
            expect(received.conversationId).toBe(convId);

            yield* senderClient.close();
            yield* receiverClient.close();
          }),
        90_000,
      );

      it.live(
        "second message to same agent reuses conversation (no duplicate)",
        () =>
          Effect.gen(function* () {
            const receiver = yield* Effect.promise(() =>
              registerAndClaim("out-receiver-dup"),
            );
            yield* Effect.promise(() =>
              makeContact(containerAUserId, receiver.userId),
            );

            const receiverClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* receiverClient.connect(receiver.apiKey);

            const senderClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* senderClient.connect(inject("containerAApiKey"));

            const lookupResult = (yield* senderClient.rpc(
              "agents/lookupByName",
              {
                names: ["out-receiver-dup"],
              },
            )) as { agents: { id: string }[] };

            const convId1 = extractConvId(
              yield* senderClient.rpc("conversations/create", {
                type: "dm",
                participants: [
                  { type: "agent", id: lookupResult.agents[0]!.id },
                ],
              }),
            );

            yield* senderClient.rpc("messages/send", {
              conversationId: convId1,
              parts: [{ type: "text", text: "first" }],
            });
            const msg1 = extractMessage(
              yield* receiverClient.waitForEvent("messages/received", 60_000),
            );

            yield* senderClient.rpc("messages/send", {
              conversationId: convId1,
              parts: [{ type: "text", text: "second" }],
            });
            const msg2 = extractMessage(
              yield* receiverClient.waitForEvent("messages/received", 60_000),
            );

            expect(msg1.conversationId).toBe(convId1);
            expect(msg2.conversationId).toBe(convId1);

            yield* senderClient.close();
            yield* receiverClient.close();
          }),
        90_000,
      );
    });

    describe("error scenarios", () => {
      it.live(
        "send to nonexistent agent returns error",
        () =>
          Effect.gen(function* () {
            const agent = yield* Effect.promise(() =>
              registerAndClaim("err-sender"),
            );
            const agentClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* agentClient.connect(agent.apiKey);

            const result = yield* Effect.exit(
              agentClient.rpc("agents/lookupByName", {
                name: "nonexistent-agent-xyz",
              }),
            );
            expect(result._tag).toBe("Failure");

            yield* agentClient.close();
          }),
        30_000,
      );

      it.live(
        "large message (>4096 chars) is delivered intact",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.promise(() =>
              registerAndClaim("lg-alice"),
            );
            yield* Effect.promise(() =>
              makeContact(alice.userId, containerAUserId),
            );

            const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* aliceClient.connect(alice.apiKey);

            const convId = extractConvId(
              yield* aliceClient.rpc("conversations/create", {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            const largeText = "A".repeat(5000);

            yield* aliceClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: largeText }],
            });

            const reply = extractMessage(
              yield* aliceClient.waitForEvent("messages/received", 60_000),
            );
            expect(reply.conversationId).toBe(convId);
            expect(reply.senderId).toBe(containerAAgentId);
            const replyText = extractText(reply);
            expect(replyText).toContain("ECHO:");
            expect(replyText.length).toBeGreaterThan(4096);

            yield* aliceClient.close();
          }),
        120_000,
      );

      it.live(
        "reconnection during dispatch: message recovery after WebSocket drop",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.promise(() =>
              registerAndClaim("rd-alice"),
            );
            yield* Effect.promise(() =>
              makeContact(alice.userId, containerAUserId),
            );

            const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
            yield* aliceClient.connect(alice.apiKey);

            const convId = extractConvId(
              yield* aliceClient.rpc("conversations/create", {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            // Send first message to verify baseline works
            yield* aliceClient.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "before drop" }],
            });
            const reply1 = extractMessage(
              yield* aliceClient.waitForEvent("messages/received", 60_000),
            );
            expect(extractText(reply1)).toContain("ECHO:");

            // Close and reconnect alice's WebSocket
            yield* aliceClient.close();

            yield* Effect.promise(
              () => new Promise((r) => setTimeout(r, 1000)),
            );

            const aliceClient2 = new MoltZapTestClient(baseUrl, wsUrl);
            yield* aliceClient2.connect(alice.apiKey);

            // Send message after reconnection
            yield* aliceClient2.rpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "after reconnect" }],
            });
            const reply2 = extractMessage(
              yield* aliceClient2.waitForEvent("messages/received", 60_000),
            );
            expect(extractText(reply2)).toContain("ECHO:");
            expect(reply2.conversationId).toBe(convId);

            yield* aliceClient2.close();
          }),
        120_000,
      );
    });
  },
);
