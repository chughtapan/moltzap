import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  agentId,
  conversationId,
  messageId,
  notificationFrame,
  notificationGroup,
} from "@moltzap/protocol";
import { decodeFrames, type DecodedNotification } from "./frame.js";

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

  // R2 regression: drift detection lives at the typed-handler boundary,
  // not the wire decoder. The wire decoder is payload-opaque (conformance
  // §5 C3 / E2 require it) but attaches the protocol definition to every
  // known-method notification, so subscribers can validate via
  // `definition.validateParams` and reject stale shapes — e.g. a
  // pre-Phase-7 `task/closed` carrying `sessionId` instead of
  // `{taskId, conversations, closedBy: {agentId, ownerId}}`.
  it("attaches definition for known methods so subscribers can reject stale `task/closed` payload", async () => {
    const stale = JSON.stringify({
      jsonrpc: "2.0",
      method: "task/closed",
      params: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        closedBy: "33333333-3333-4333-8333-333333333333",
      },
    });

    const decoded = await Effect.runPromise(decodeFrames(stale));
    expect(decoded).toHaveLength(1);
    const notification = decoded[0] as DecodedNotification;
    expect(notification._tag).toBe("Notification");
    expect(notification.method).toBe(TaskClosedNotificationDefinition.name);

    // The definition attached by the decoder is the live one; calling
    // `validateParams` on the stale payload rejects, proving subscribers
    // (or typed handlers) can detect drift even though the decoder
    // itself stays opaque.
    const definition = notificationGroup.byName.get(notification.method);
    expect(definition).toBeDefined();
    expect(definition?.validateParams(notification.params)).toBe(false);

    // And the live shape passes — proves the validator is not vacuously false.
    expect(
      definition?.validateParams({
        taskId: "11111111-1111-4111-8111-111111111111",
        conversations: { main: "22222222-2222-4222-8222-222222222222" },
        closedBy: {
          agentId: "33333333-3333-4333-8333-333333333333",
          ownerId: "owner-1",
        },
      }),
    ).toBe(true);
  });
});
