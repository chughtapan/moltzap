import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { MessageReceivedNotificationDefinition } from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { decodeFrames } from "./frame.js";
import { MalformedFrameError } from "./errors.js";

const TEST_MESSAGE = {
  id: messageId("11111111-1111-4111-8111-111111111111"),
  conversationId: conversationId("22222222-2222-4222-8222-222222222222"),
  senderId: agentId("33333333-3333-4333-8333-333333333333"),
  parts: [{ type: "text" as const, text: "hello" }],
  createdAt: "2026-05-03T00:00:00.000Z",
};
const TEST_TASK_ID = taskId("44444444-4444-4444-8444-444444444444");

it("decodes one WebSocket notification message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const raw = JSON.stringify(
        MessageReceivedNotificationDefinition.encode({
          taskId: TEST_TASK_ID,
          message: TEST_MESSAGE,
        }),
      );

      const decoded = yield* decodeFrames(raw);

      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toMatchObject({
        _tag: "Notification",
        method: MessageReceivedNotificationDefinition.name,
        params: { taskId: TEST_TASK_ID, message: TEST_MESSAGE },
      });
    }),
  ));

// S9 fail-close: stale shapes are rejected at the wire boundary.
// Pre-Phase-7 `task/closed` carrying `sessionId` instead of
// `{taskId, conversations, closedBy: {agentId, ownerId}}` decodes to
// `MalformedFrameError`; subscribers no longer need to defend
// against drift downstream because the decoder fails closed.
it("fail-closes stale `task/closed` payload at the wire boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stale = JSON.stringify({
        jsonrpc: "2.0",
        method: "task/closed",
        params: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          closedBy: "33333333-3333-4333-8333-333333333333",
        },
      });

      const exit = yield* Effect.exit(decodeFrames(stale));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(error).toBeInstanceOf(MalformedFrameError);
      }
    }),
  ));

// S9 also rejects unknown notification methods at the wire boundary.
it("fail-closes unknown notification method", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stranger = JSON.stringify({
        jsonrpc: "2.0",
        method: "some/unregistered-method",
        params: {},
      });
      const exit = yield* Effect.exit(decodeFrames(stranger));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  ));
