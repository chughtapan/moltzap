import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
} from "../helpers.js";
import {
  InMemoryTraceCaptureLive,
  type TraceCapture,
} from "../../../runtime-surface/trace-capture.js";
import {
  ConversationsCreate,
  MessagesSend,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";

let traceCapture: TraceCapture;

beforeAll(async () => {
  const server = await startTestServer({
    traceCaptureLayer: InMemoryTraceCaptureLive,
  });
  traceCapture = server.coreApp.traceCapture;
});

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  await Effect.runPromise(traceCapture.clear());
});

describe("trace capture", () => {
  it.live("records delivered messages through the server DI capture", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-trace-capture");
      const bob = yield* registerAndConnect("bob-trace-capture");

      const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      yield* alice.client.sendRpc(MessagesSend, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "hello from trace capture test" }],
      });
      yield* bob.client.waitForNotification(
        MessageReceivedNotificationDefinition,
      );

      const events = yield* traceCapture.snapshot();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        _tag: "Message",
        channelKey: conv.conversation.id,
        senderDisplayName: alice.name,
        recipientAgentIds: [bob.agentId],
        deliveredAgentIds: [bob.agentId],
        message: {
          conversationId: conv.conversation.id,
          senderId: alice.agentId,
          parts: [{ type: "text", text: "hello from trace capture test" }],
        },
      });

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );

  // Phase 7 cutover removed `apps/create`'s session bootstrap, which
  // owned the path that wired `before_message_delivery` to the
  // manifest-declared conversation map. Trace-capture for blocked hooks
  // reactivates with Phase 9's TM-topology hook wiring.
  it.todo(
    "records blocked before_message_delivery hooks (Phase 9 reactivation)",
  );
});
