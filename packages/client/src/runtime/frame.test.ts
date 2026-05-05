import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  MessageReceivedNotificationDefinition,
  agentId,
  conversationId,
  messageId,
  notificationFrame,
} from "@moltzap/protocol";
import { decodeFrames } from "./frame.js";

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
        notificationFrame(MessageReceivedNotificationDefinition, {
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
      _tag: "Response",
      id: "rpc-7",
      result: { ok: true },
    });
  });

  // R2 regression: per-payload schema validation rejects pre-Phase-7
  // shapes on a known notification method. The wire envelope is still
  // a JSON-RPC notification and the method name still resolves to the
  // current task/closed descriptor; only the payload shape drifted
  // (renamed `sessionId`→`taskId`, augmented `closedBy`).
  it("rejects a stale `task/closed` payload (pre-Phase-7 shape)", async () => {
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
      const error = exit.cause;
      // Cause is `Fail(MalformedFrameError)` — the typed payload
      // mismatch is rejected at the envelope-decoder boundary.
      expect(JSON.stringify(error)).toMatch(/MalformedFrameError/);
    }
  });
});
