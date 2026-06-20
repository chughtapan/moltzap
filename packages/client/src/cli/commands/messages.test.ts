/**
 * Unit tests for the `moltzap messages list` success and RPC-failure paths.
 */
import { Effect, Exit, Logger } from "effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { messagesListHandler } from "./messages.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";

import {
  conversationId as makeConversationId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";

const it = effectIt.effect;
const TASK_ID = makeTaskId("00000000-0000-4000-8000-00000000001a");
const CONVERSATION_ID = makeConversationId(
  "00000000-0000-4000-8000-00000000000c",
);
const FIRST_MESSAGE_ID = "00000000-0000-4000-8000-00000000000a";
const SECOND_MESSAGE_ID = "00000000-0000-4000-8000-00000000000b";
const SENDER_A = "00000000-0000-4000-8000-0000000000a1";
const SENDER_B = "00000000-0000-4000-8000-0000000000b1";
const FIRST_CREATED_AT = "2026-04-24T00:00:00Z";
const SECOND_CREATED_AT = "2026-04-24T00:00:01Z";
const DEFAULT_LIMIT = 50;
const SilentLogger = Logger.replace(Logger.defaultLogger, Logger.none);

const messagesListSuccess = () => ({
  messages: [
    {
      id: FIRST_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SENDER_A,
      createdAt: FIRST_CREATED_AT,
      parts: [{ type: "text" as const, text: "hello" }],
    },
    {
      id: SECOND_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SENDER_B,
      createdAt: SECOND_CREATED_AT,
      parts: [{ type: "text" as const, text: "hi" }],
    },
  ],
  hasMore: false,
});

const emptyMessagesList = () => ({
  messages: [],
  hasMore: false,
});

function transportFailure() {
  return new Error("fail");
}

function runMessagesList(
  transport: ReturnType<typeof makeFakeTransport>["transport"],
  limit?: number,
) {
  return messagesListHandler({
    taskId: TASK_ID,
    conversationId: CONVERSATION_ID,
    ...(limit !== undefined ? { limit } : {}),
  }).pipe(
    Effect.provideService(Transport, transport),
    Effect.provide(SilentLogger),
  );
}

describe("messages list", () => {
  it("calls messages/list with { conversationId, limit? }", () =>
    Effect.gen(function* () {
      // Fixture matches the `messages/list` result shape: every required
      // `MessageSchema` field is present (including `conversationId`).
      // `senderName` is the CLI display fallback the handler reads; it is
      // not part of `MessageSchema` itself (see WireMessage in messages.ts).
      const { calls, transport } = makeFakeTransport(messagesListSuccess);
      yield* runMessagesList(transport, DEFAULT_LIMIT);
      expect(calls[0]).toEqual({
        method: LocalDaemonCommands.MessagesList,
        params: {
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          limit: DEFAULT_LIMIT,
        },
      });
    }));

  it("omits limit when absent", () =>
    Effect.gen(function* () {
      const { calls, transport } = makeFakeTransport(emptyMessagesList);
      yield* runMessagesList(transport);
      expect(calls[0]?.params).toEqual({
        taskId: TASK_ID,
        conversationId: CONVERSATION_ID,
      });
    }));

  it("surfaces TransportRpcError", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport(transportFailure);
      const result = yield* Effect.exit(runMessagesList(transport));
      expect(Exit.isFailure(result)).toBe(true);
    }));
});
