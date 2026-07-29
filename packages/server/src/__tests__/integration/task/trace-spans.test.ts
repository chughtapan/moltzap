import { WIRE_ERROR_TAG } from "@moltzap/protocol/testing";
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Either, Fiber } from "effect";
import type { CoreTestSpanExporterPort } from "../../../test-utils/index.js";

import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  registerApp,
  connectAppClient,
  getBaseUrl,
} from "../helpers.js";
import {
  DEFAULT_APP_ID,
  taskCreate,
  taskRequest,
} from "@moltzap/protocol/task";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import {
  messageReceivedNotificationDefinition,
  messagesAuthorize,
  messagesSend,
} from "@moltzap/protocol/message";
import { conversationCreate } from "@moltzap/protocol/conversation";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AppId } from "@moltzap/protocol/task";
import type { AppManifest } from "@moltzap/protocol/identity";

let tracePort: CoreTestSpanExporterPort;
const TRACE_APP_ID = "00000000-0000-4000-8000-000000010006" as AppId;
const TRACE_BLOCK_REASON = "trace-block";
const TRACE_BLOCKED_TEXT = "blocked trace span";
const TRACE_APP_MANIFEST: AppManifest = {
  appId: TRACE_APP_ID,
  name: "Trace Span Test App",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "hook", timeoutMs: 5_000 },
    task_create: { kind: "accept" },
  },
};

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
      yield* Effect.sync(() => tracePort.reset());
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
  attributes: Record<string, unknown> | undefined,
  plaintext: string,
): void {
  const serialized = JSON.stringify(attributes ?? {});
  expect(serialized).not.toContain(plaintext);
}

function expectHookBlocked(outcome: Either.Either<unknown, unknown>): void {
  Either.match(outcome, {
    onLeft: (error) => {
      expect((error as { _tag?: string })._tag).toBe(
        WIRE_ERROR_TAG.HookBlocked,
      );
    },
    onRight: () => expect.fail("expected HookBlockedError"),
  });
}

function blockingMessageHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () =>
        Effect.succeed({
          verdict: { decision: "Block" as const, reason: TRACE_BLOCK_REASON },
        }),
    },
    [taskCreate.name]: {
      definition: taskCreate,
      handle: () =>
        Effect.succeed({ verdict: { decision: "accept" as const } }),
    },
  };
}

function emitDeliveredMessageSpan() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-trace-span");
    const bob = yield* registerAndConnect("bob-trace-span");

    const conv = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const conversationId = conv.conversation!.id;

    const messageText = "hello from trace span test";
    const bobEventFiber = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );
    yield* alice.client.sendRpc(messagesSend, {
      taskId: conv.task.id,
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
    expectNoPlaintext(attributes, messageText);

    yield* alice.client.close();
    yield* bob.client.close();
  });
}

function emitBlockedHookSpan() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-trace-span-blocked");
    const bob = yield* registerAndConnect("bob-trace-span-blocked");
    const registered = yield* registerApp(getBaseUrl(), TRACE_APP_MANIFEST);
    const appClient = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      blockingMessageHandlers(),
    );

    const task = yield* alice.client.sendRpc(taskRequest, {
      appId: registered.appId,
      invitedAgentIds: [bob.agentId],
    });
    // The app creates the conversation off its own `AppConnection`
    // (`seedCreatorAsParticipant: false`); alice (the sender) is added
    // explicitly so her `agent/message/send` passes the participant gate and
    // reaches the `before_message_delivery` hook (vs. a participant-gate
    // ForbiddenError firing first).
    const conv = yield* appClient.sendRpc(conversationCreate, {
      taskId: task.task.id,
      participants: [alice.agentId, bob.agentId],
    });
    const outcome = yield* Effect.either(
      alice.client.sendRpc(messagesSend, {
        taskId: task.task.id,
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: TRACE_BLOCKED_TEXT }],
      }),
    );
    expectHookBlocked(outcome);

    const attributes = findSpanAttributes("moltzap.message.blocked");
    expect(attributes).toBeDefined();
    expect(attributes).toMatchObject({
      "moltzap.hook.name": "before_message_delivery",
      "moltzap.message.conversation_id": conv.conversation.id,
      "moltzap.message.sender_id": alice.agentId,
      "moltzap.channel.key": conv.conversation.id,
      "moltzap.sender.display_name": alice.name,
      "moltzap.block.reason": TRACE_BLOCK_REASON,
      // Metadata only — message body plaintext is never recorded on spans.
      "moltzap.message.part_count": 1,
      "moltzap.message.text_part_count": 1,
      "moltzap.message.text_length": TRACE_BLOCKED_TEXT.length,
    });
    expect(attributes?.["moltzap.message.id"]).toBeDefined();
    expect(attributes?.["moltzap.message.created_at"]).toBeDefined();
    // Redaction guarantee: no span attribute carries message body text.
    expect(attributes?.["moltzap.message.text_parts"]).toBeUndefined();
    expectNoPlaintext(attributes, TRACE_BLOCKED_TEXT);

    yield* alice.client.close();
    yield* bob.client.close();
  });
}

describe("trace spans", () => {
  it("emits a moltzap.message.delivered span for delivered messages", () =>
    emitDeliveredMessageSpan());

  it("emits a moltzap.message.blocked span for blocked before_message_delivery hooks", () =>
    emitBlockedHookSpan());
});
