/**
 * Unit tests for `moltzap messages list` handler. Spec test-coverage floor:
 * one success + one RPC-failure path.
 */
import { Effect, Exit } from "effect";
import { it as effectIt } from "@effect/vitest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  vi,
  type MockInstance,
} from "vitest";
import { messagesListHandler } from "./messages.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";

import { MessagesList } from "@moltzap/protocol";
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
  }).pipe(Effect.provideService(Transport, transport));
}

describe("messages list", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls messages/list with { conversationId, limit? } and emits one line per message", () =>
    Effect.gen(function* () {
      // Fixture matches the `messages/list` result shape: every required
      // `MessageSchema` field is present (including `conversationId`).
      // `senderName` is the CLI display fallback the handler reads; it is
      // not part of `MessageSchema` itself (see WireMessage in messages.ts).
      const { calls, transport } = makeFakeTransport(messagesListSuccess);
      yield* runMessagesList(transport, DEFAULT_LIMIT);
      expect(calls[0]).toEqual({
        method: MessagesList.name,
        params: {
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          limit: DEFAULT_LIMIT,
        },
      });
      expect(stdout).toHaveBeenCalledTimes(2);
      // Regression #216: first column is `createdAt`, never `undefined`.
      // MessageSchema has no `seq` field; the previous output stringified
      // `m.seq` as the literal "undefined" in the leading column.
      const firstLine = String(stdout.mock.calls[0]?.[0] ?? "");
      expect(firstLine.startsWith("undefined\t")).toBe(false);
      expect(firstLine).toBe(`${FIRST_CREATED_AT}\t${SENDER_A}\thello`);
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
