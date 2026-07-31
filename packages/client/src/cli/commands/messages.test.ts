/**
 * Unit tests for the `moltzap messages list` success and RPC-failure paths.
 */
import { Effect, Exit, Logger } from "effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { messagesListHandler } from "./messages.js";
import { transportSchema } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";
import { localDaemonCommands } from "../../local-daemon-rpc.js";

import {
  agentId as makeAgentId,
  conversationId as makeConversationId,
  messageId as makeMessageId,
} from "@moltzap/protocol/testing";

const it = effectIt.effect;
const CONVERSATION_ID = makeConversationId(
  "00000000-0000-4000-8000-00000000000c",
);
const FIRST_MESSAGE_ID = makeMessageId("00000000-0000-4000-8000-00000000000a");
const SECOND_MESSAGE_ID = makeMessageId("00000000-0000-4000-8000-00000000000b");
const SENDER_A = makeAgentId("00000000-0000-4000-8000-0000000000a1");
const SENDER_B = makeAgentId("00000000-0000-4000-8000-0000000000b1");
const FIRST_CREATED_AT = "2026-04-24T00:00:00Z";
const SECOND_CREATED_AT = "2026-04-24T00:00:01Z";
const DEFAULT_LIMIT = 50;
const silentLogger = Logger.replace(Logger.defaultLogger, Logger.none);

const messagesListSuccess = () => ({
  messages: [
    {
      id: FIRST_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SENDER_A,
      createdAt: FIRST_CREATED_AT,
      parts: [{ type: "text" as const, text: "hello" }] as const,
    },
    {
      id: SECOND_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SENDER_B,
      createdAt: SECOND_CREATED_AT,
      parts: [{ type: "text" as const, text: "hi" }] as const,
    },
  ],
});

const emptyMessagesList = () => ({
  messages: [],
});

function transportFailure() {
  return new Error("fail");
}

function runMessagesList(
  transport: ReturnType<typeof makeFakeTransport>["transport"],
  limit?: number,
) {
  return messagesListHandler({
    conversationId: CONVERSATION_ID,
    ...(limit !== undefined ? { limit } : {}),
  }).pipe(
    Effect.provideService(transportSchema, transport),
    Effect.provide(silentLogger),
  );
}

describe("messages list", () => {
  it("calls messages/list with { conversationId, limit? }", () =>
    Effect.gen(function* () {
      // Fixture matches the `messages/list` result shape: every required
      // `MessageSchema` field is present (including `conversationId`).
      // `senderName` is the CLI display fallback the handler reads; it is
      // not part of `MessageSchema` itself (see WireMessage in messages.ts).
      const { calls, transport } = makeFakeTransport({
        [localDaemonCommands.messagesList]: messagesListSuccess,
      });
      yield* runMessagesList(transport, DEFAULT_LIMIT);
      expect(calls[0]).toEqual({
        method: localDaemonCommands.messagesList,
        params: {
          conversationId: CONVERSATION_ID,
          limit: DEFAULT_LIMIT,
        },
      });
    }));

  it("omits limit when absent", () =>
    Effect.gen(function* () {
      const { calls, transport } = makeFakeTransport({
        [localDaemonCommands.messagesList]: emptyMessagesList,
      });
      yield* runMessagesList(transport);
      expect(calls[0]?.params).toEqual({
        conversationId: CONVERSATION_ID,
      });
    }));

  it("surfaces TransportRpcError", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport({
        [localDaemonCommands.messagesList]: transportFailure,
      });
      const result = yield* Effect.exit(runMessagesList(transport));
      expect(Exit.isFailure(result)).toBe(true);
    }));
});
