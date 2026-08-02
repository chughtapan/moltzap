import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Fiber } from "effect";
import type { CoreTestSpanExporterPort } from "../../../test-utils/index.js";

import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
} from "../helpers.js";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
} from "@moltzap/protocol/message";
import { agentConversationCreate } from "@moltzap/protocol/conversation";

let tracePort: CoreTestSpanExporterPort;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      // Default test wiring provides a trace port. A null port means the
      // caller supplied custom trace processing, which these tests do not.
      if (server.spanExporter === null) {
        return yield* Effect.die(
          new Error("expected default trace exporter port"),
        );
      }
      tracePort = server.spanExporter;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* resetTestDbEffect();
      yield* Effect.sync(() => {
        tracePort.reset();
      });
    }),
  ),
);

function findSpanAttributes(name: string): Record<string, unknown> | undefined {
  const span = tracePort.getFinishedSpans().find((s) => s.name === name);
  return span?.attributes;
}

// Effect's `withSpan` JSON-encodes array/object attribute values into strings
// (OTel's native AttributeValue array support is bypassed by the Effect
// bridge), so array attributes arrive as JSON text. Parse back to compare the
// content without coupling the test to Effect's exact JSON formatting.
function parseArrayAttribute(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

// Assert the message body plaintext appears in NO span attribute value
// (stringified to catch JSON-encoded arrays/objects too). The redaction
// contract: spans carry message-shape metadata, never body content.
function expectNoPlaintext(
  plaintext: string,
  attributes?: Record<string, unknown>,
): void {
  const serialized = JSON.stringify(attributes ?? {});
  expect(serialized).not.toContain(plaintext);
}

function emitDeliveredMessageSpan() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-trace-span");
    const bob = yield* registerAndConnect("bob-trace-span");

    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });
    const conversationId = conv.conversation.id;

    const messageText = "hello from trace span test";
    const bobEventFiber = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );
    yield* alice.client.sendRpc(messagesSend, {
      conversationId,
      parts: [{ type: "text", text: messageText }],
    });
    yield* Fiber.join(bobEventFiber);

    const attributes = findSpanAttributes("moltzap.message.delivered");
    expect(attributes).toBeDefined();
    expect(attributes).toMatchObject({
      "moltzap.message.conversation_id": conversationId,
      "moltzap.message.sender_id": alice.agentId,
      "moltzap.channel.key": conversationId,
      "moltzap.sender.display_name": alice.name,
      // Metadata only — message body plaintext is never recorded on spans.
      "moltzap.message.part_count": 1,
      "moltzap.message.text_part_count": 1,
      "moltzap.message.text_length": messageText.length,
    });
    expect(attributes?.["moltzap.message.id"]).toBeDefined();
    expect(attributes?.["moltzap.message.created_at"]).toBeDefined();
    expect(parseArrayAttribute(attributes?.["moltzap.recipients"])).toEqual([
      bob.agentId,
    ]);
    expect(parseArrayAttribute(attributes?.["moltzap.delivered"])).toEqual([
      bob.agentId,
    ]);
    // Redaction guarantee: no span attribute carries message body text.
    expect(attributes?.["moltzap.message.text_parts"]).toBeUndefined();
    expectNoPlaintext(messageText, attributes);

    yield* alice.client.close();
    yield* bob.client.close();
  });
}

describe("trace spans", () => {
  it("emits a moltzap.message.delivered span for delivered messages", () =>
    emitDeliveredMessageSpan());
});
