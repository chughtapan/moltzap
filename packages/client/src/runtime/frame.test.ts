import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { MessageReceivedNotificationDefinition } from "@moltzap/protocol";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import { decodeFrames } from "./frame.js";
import { MalformedFrameError } from "./errors.js";

const TEST_MESSAGE = {
  id: messageId("11111111-1111-4111-8111-111111111111"),
  conversationId: conversationId("22222222-2222-4222-8222-222222222222"),
  senderId: agentId("33333333-3333-4333-8333-333333333333"),
  parts: [{ type: "text" as const, text: "hello" }],
  createdAt: "2026-05-03T00:00:00.000Z",
};

describe("decodeFrames", () => {
  it("decodes padded chunks that contain both a notification and a response", async () => {
    const raw =
      JSON.stringify(
        MessageReceivedNotificationDefinition.encode({
          message: TEST_MESSAGE,
        }),
      ) +
      "\u0000\n" +
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-7",
        result: { ok: true },
      });

    const decoded = await Effect.runPromise(decodeFrames(raw));

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({
      _tag: "Notification",
      method: MessageReceivedNotificationDefinition.name,
      params: { message: TEST_MESSAGE },
    });
    expect(decoded[1]).toMatchObject({
      _tag: "ResponseSuccess",
      id: "rpc-7",
      result: { ok: true },
    });
  });

  // S9 fail-close: stale shapes are rejected at the wire boundary.
  // Pre-Phase-7 `task/closed` carrying `sessionId` instead of
  // `{taskId, conversations, closedBy: {agentId, ownerId}}` decodes to
  // `MalformedFrameError`; subscribers no longer need to defend
  // against drift downstream because the decoder fails closed.
  it("fail-closes stale `task/closed` payload at the wire boundary", async () => {
    const stale = JSON.stringify({
      jsonrpc: "2.0",
      method: "task/closed",
      params: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        closedBy: "33333333-3333-4333-8333-333333333333",
      },
    });

    const exit = await Effect.runPromiseExit(decodeFrames(stale));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(error).toBeInstanceOf(MalformedFrameError);
    }
  });

  // S9 also rejects unknown notification methods at the wire boundary.
  it("fail-closes unknown notification method", async () => {
    const stranger = JSON.stringify({
      jsonrpc: "2.0",
      method: "some/unregistered-method",
      params: {},
    });
    const exit = await Effect.runPromiseExit(decodeFrames(stranger));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
