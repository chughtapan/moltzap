/**
 * Tier 2: Real OpenClaw gateway + real MoltZap server integration tests.
 *
 * Every test uses shared OpenClaw containers (started in globalSetup) with an
 * echo model provider -- no LLM API keys required. Verifies message routing,
 * not LLM quality.
 */

import { describe, expect, inject, beforeAll } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { MoltZapWsClient } from "@moltzap/client";
import { stripWsPath } from "@moltzap/client/test";
import { getLogs } from "../test-utils/container-core.js";
import {
  registerAndClaim,
  extractMessage,
  extractConvId,
  extractText,
} from "./test-helpers.js";

import {
  AgentsLookupByName,
  ConversationsCreate,
  MessagesSend,
} from "@moltzap/protocol";

let wsUrl: string;

const GATEWAY_LIFECYCLE_TIMEOUT_MS = 30_000;
const NOTIFICATION_WAIT_TIMEOUT_MS = 60_000;
const STANDARD_SCENARIO_TIMEOUT_MS = 90_000;
const LONG_SCENARIO_TIMEOUT_MS = 120_000;
const CROSS_CONTAINER_SCENARIO_TIMEOUT_MS = 180_000;
const CONVERSATION_EVENT_SETTLE_MS = 500;
const LARGE_MESSAGE_CHARS = 5_000;
const MIN_LARGE_REPLY_CHARS = 4_096;
const RECONNECT_SETTLE_MS = 1_000;

beforeAll(() => {
  wsUrl = inject("wsUrl");
});

describe.skipIf(inject("containerAId") === "")(
  "Real OpenClaw gateway integration",
  () => {
    const containerAId = inject("containerAId");
    const containerAAgentId = inject("containerAAgentId");
    const containerBAgentId = inject("containerBAgentId");

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
      GATEWAY_LIFECYCLE_TIMEOUT_MS,
    );

    // --- Agent-to-agent tests (shared container A) ---

    describe("agent-to-agent messaging", () => {
      it.live(
        "DM: alice sends -> OpenClaw dispatch -> echo reply arrives",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.tryPromise({
              try: () => registerAndClaim("a2a-alice-dm"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const aliceClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: alice.apiKey,
            });
            yield* aliceClient.connect();

            const convId = extractConvId(
              yield* aliceClient.sendRpc(ConversationsCreate, {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            yield* aliceClient.sendRpc(MessagesSend, {
              conversationId: convId,
              parts: [{ type: "text", text: "hello from alice" }],
            });

            const reply = extractMessage(
              yield* aliceClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );
            expect(reply.parts.length).toBeGreaterThan(0);
            expect(reply.conversationId).toBe(convId);
            expect(reply.senderId).toBe(containerAAgentId);
            expect(extractText(reply)).toContain("ECHO:");

            yield* aliceClient.close();
          }),
        STANDARD_SCENARIO_TIMEOUT_MS,
      );

      it.live(
        "group: message dispatched through real OpenClaw",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.tryPromise({
              try: () => registerAndClaim("a2a-alice-grp"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });
            const eve = yield* Effect.tryPromise({
              try: () => registerAndClaim("a2a-eve-grp"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const aliceClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: alice.apiKey,
            });
            yield* aliceClient.connect();

            const convId = extractConvId(
              yield* aliceClient.sendRpc(ConversationsCreate, {
                type: "group",
                name: "Integration Group",
                participants: [
                  { type: "agent", id: containerAAgentId },
                  { type: "agent", id: eve.agentId },
                ],
              }),
            );

            // Wait for conversation event to propagate to the gateway
            yield* Effect.promise(
              () =>
                new Promise((r) => setTimeout(r, CONVERSATION_EVENT_SETTLE_MS)),
            );

            yield* aliceClient.sendRpc(MessagesSend, {
              conversationId: convId,
              parts: [{ type: "text", text: "hello group" }],
            });

            const reply = extractMessage(
              yield* aliceClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );
            expect(reply.parts.length).toBeGreaterThan(0);
            expect(reply.conversationId).toBe(convId);
            expect(extractText(reply)).toContain("ECHO:");

            yield* aliceClient.close();
          }),
        STANDARD_SCENARIO_TIMEOUT_MS,
      );

      it.live(
        "rapid: multiple messages all get echo replies",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.tryPromise({
              try: () => registerAndClaim("a2a-alice-rapid"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const aliceClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: alice.apiKey,
            });
            yield* aliceClient.connect();

            const convId = extractConvId(
              yield* aliceClient.sendRpc(ConversationsCreate, {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            for (let i = 0; i < 3; i++) {
              yield* aliceClient.sendRpc(MessagesSend, {
                conversationId: convId,
                parts: [{ type: "text", text: `Message ${i}` }],
              });
            }

            const replies = yield* Effect.all(
              [
                aliceClient.waitForNotification(
                  "messages/received",
                  NOTIFICATION_WAIT_TIMEOUT_MS,
                ),
                aliceClient.waitForNotification(
                  "messages/received",
                  NOTIFICATION_WAIT_TIMEOUT_MS,
                ),
                aliceClient.waitForNotification(
                  "messages/received",
                  NOTIFICATION_WAIT_TIMEOUT_MS,
                ),
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
        LONG_SCENARIO_TIMEOUT_MS,
      );
    });

    // --- Two agents in separate containers ---

    it.live(
      "two agents: both receive and reply from their own containers",
      () =>
        Effect.gen(function* () {
          const alice = yield* Effect.tryPromise({
            try: () => registerAndClaim("2a-alice"),
            catch: (err) =>
              err instanceof Error ? err : new Error(String(err)),
          });

          const aliceClient = new MoltZapWsClient({
            serverUrl: stripWsPath(wsUrl),
            agentKey: alice.apiKey,
          });
          yield* aliceClient.connect();

          const convAId = extractConvId(
            yield* aliceClient.sendRpc(ConversationsCreate, {
              type: "dm",
              participants: [{ type: "agent", id: containerAAgentId }],
            }),
          );

          const convBId = extractConvId(
            yield* aliceClient.sendRpc(ConversationsCreate, {
              type: "dm",
              participants: [{ type: "agent", id: containerBAgentId }],
            }),
          );

          yield* aliceClient.sendRpc(MessagesSend, {
            conversationId: convAId,
            parts: [{ type: "text", text: "hello container-a" }],
          });
          yield* aliceClient.sendRpc(MessagesSend, {
            conversationId: convBId,
            parts: [{ type: "text", text: "hello container-b" }],
          });

          const events = yield* Effect.all(
            [
              aliceClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
              aliceClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
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
      CROSS_CONTAINER_SCENARIO_TIMEOUT_MS,
    );

    // --- Aggressive scenarios ---

    describe("outbound proactive messaging", () => {
      it.live(
        "agent proactively sends to agent:<name>, DM auto-created, message arrives",
        () =>
          Effect.gen(function* () {
            const receiver = yield* Effect.tryPromise({
              try: () => registerAndClaim("out-receiver-pro"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const receiverClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: receiver.apiKey,
            });
            yield* receiverClient.connect();

            const senderClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: inject("containerAApiKey"),
            });
            yield* senderClient.connect();

            const lookupResult = (yield* senderClient.sendRpc(
              AgentsLookupByName,
              {
                names: ["out-receiver-pro"],
              },
            )) as { agents: { id: string }[] };

            const convId = extractConvId(
              yield* senderClient.sendRpc(ConversationsCreate, {
                type: "dm",
                participants: [
                  { type: "agent", id: lookupResult.agents[0]!.id },
                ],
              }),
            );

            yield* senderClient.sendRpc(MessagesSend, {
              conversationId: convId,
              parts: [{ type: "text", text: "proactive hello" }],
            });

            const received = extractMessage(
              yield* receiverClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );
            expect(received.senderId).toBe(containerAAgentId);
            expect(extractText(received)).toBe("proactive hello");
            expect(received.conversationId).toBe(convId);

            yield* senderClient.close();
            yield* receiverClient.close();
          }),
        STANDARD_SCENARIO_TIMEOUT_MS,
      );

      it.live(
        "second message to same agent reuses conversation (no duplicate)",
        () =>
          Effect.gen(function* () {
            const receiver = yield* Effect.tryPromise({
              try: () => registerAndClaim("out-receiver-dup"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const receiverClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: receiver.apiKey,
            });
            yield* receiverClient.connect();

            const senderClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: inject("containerAApiKey"),
            });
            yield* senderClient.connect();

            const lookupResult = (yield* senderClient.sendRpc(
              AgentsLookupByName,
              {
                names: ["out-receiver-dup"],
              },
            )) as { agents: { id: string }[] };

            const convId1 = extractConvId(
              yield* senderClient.sendRpc(ConversationsCreate, {
                type: "dm",
                participants: [
                  { type: "agent", id: lookupResult.agents[0]!.id },
                ],
              }),
            );

            yield* senderClient.sendRpc(MessagesSend, {
              conversationId: convId1,
              parts: [{ type: "text", text: "first" }],
            });
            const msg1 = extractMessage(
              yield* receiverClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );

            yield* senderClient.sendRpc(MessagesSend, {
              conversationId: convId1,
              parts: [{ type: "text", text: "second" }],
            });
            const msg2 = extractMessage(
              yield* receiverClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );

            expect(msg1.conversationId).toBe(convId1);
            expect(msg2.conversationId).toBe(convId1);

            yield* senderClient.close();
            yield* receiverClient.close();
          }),
        STANDARD_SCENARIO_TIMEOUT_MS,
      );
    });

    describe("error scenarios", () => {
      it.live(
        "send to nonexistent agent returns error",
        () =>
          Effect.gen(function* () {
            const agent = yield* Effect.tryPromise({
              try: () => registerAndClaim("err-sender"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });
            const agentClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: agent.apiKey,
            });
            yield* agentClient.connect();

            const result = yield* Effect.exit(
              agentClient.sendRpc(AgentsLookupByName, {
                name: "nonexistent-agent-xyz",
              }),
            );
            expect(result._tag).toBe("Failure");

            yield* agentClient.close();
          }),
        GATEWAY_LIFECYCLE_TIMEOUT_MS,
      );

      it.live(
        "large message (>4096 chars) is delivered intact",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.tryPromise({
              try: () => registerAndClaim("lg-alice"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const aliceClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: alice.apiKey,
            });
            yield* aliceClient.connect();

            const convId = extractConvId(
              yield* aliceClient.sendRpc(ConversationsCreate, {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            const largeText = "A".repeat(LARGE_MESSAGE_CHARS);

            yield* aliceClient.sendRpc(MessagesSend, {
              conversationId: convId,
              parts: [{ type: "text", text: largeText }],
            });

            const reply = extractMessage(
              yield* aliceClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );
            expect(reply.conversationId).toBe(convId);
            expect(reply.senderId).toBe(containerAAgentId);
            const replyText = extractText(reply);
            expect(replyText).toContain("ECHO:");
            expect(replyText.length).toBeGreaterThan(MIN_LARGE_REPLY_CHARS);

            yield* aliceClient.close();
          }),
        LONG_SCENARIO_TIMEOUT_MS,
      );

      it.live(
        "reconnection during dispatch: message recovery after WebSocket drop",
        () =>
          Effect.gen(function* () {
            const alice = yield* Effect.tryPromise({
              try: () => registerAndClaim("rd-alice"),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });

            const aliceClient = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: alice.apiKey,
            });
            yield* aliceClient.connect();

            const convId = extractConvId(
              yield* aliceClient.sendRpc(ConversationsCreate, {
                type: "dm",
                participants: [{ type: "agent", id: containerAAgentId }],
              }),
            );

            // Send first message to verify baseline works
            yield* aliceClient.sendRpc(MessagesSend, {
              conversationId: convId,
              parts: [{ type: "text", text: "before drop" }],
            });
            const reply1 = extractMessage(
              yield* aliceClient.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );
            expect(extractText(reply1)).toContain("ECHO:");

            // Close and reconnect alice's WebSocket
            yield* aliceClient.close();

            yield* Effect.promise(
              () => new Promise((r) => setTimeout(r, RECONNECT_SETTLE_MS)),
            );

            const aliceClient2 = new MoltZapWsClient({
              serverUrl: stripWsPath(wsUrl),
              agentKey: alice.apiKey,
            });
            yield* aliceClient2.connect();

            // Send message after reconnection
            yield* aliceClient2.sendRpc(MessagesSend, {
              conversationId: convId,
              parts: [{ type: "text", text: "after reconnect" }],
            });
            const reply2 = extractMessage(
              yield* aliceClient2.waitForNotification(
                "messages/received",
                NOTIFICATION_WAIT_TIMEOUT_MS,
              ),
            );
            expect(extractText(reply2)).toContain("ECHO:");
            expect(reply2.conversationId).toBe(convId);

            yield* aliceClient2.close();
          }),
        LONG_SCENARIO_TIMEOUT_MS,
      );
    });
  },
);
