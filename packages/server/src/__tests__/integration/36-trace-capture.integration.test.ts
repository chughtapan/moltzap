import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
} from "./helpers.js";
import {
  InMemoryTraceCaptureLive,
  type TraceCapture,
} from "../../runtime-surface/trace-capture.js";

let traceCapture: TraceCapture;

beforeAll(async () => {
  const server = await startTestServer({
    traceCaptureLayer: InMemoryTraceCaptureLive,
  });
  traceCapture = server.coreApp.traceCapture;
}, 60_000);

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

      const conv = (yield* alice.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      yield* alice.client.sendRpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "hello from trace capture test" }],
      });
      yield* bob.client.waitForEvent("messages/received");

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
});
