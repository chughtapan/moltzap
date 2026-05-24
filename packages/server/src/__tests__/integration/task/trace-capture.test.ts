import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Either } from "effect";

import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  type ConnectedAgent,
} from "../helpers.js";
import {
  InMemoryTraceCaptureLive,
  type TraceCapture,
} from "../../../runtime-surface/trace-capture.js";
import {
  AppsRegister,
  DEFAULT_APP_ID,
  HookBlockedError,
  MessagesAuthorize,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskConversationCreate,
  TaskCreate,
  TaskRequest,
  type AppId,
  type AppManifest,
} from "@moltzap/protocol";

let traceCapture: TraceCapture;
const TRACE_APP_ID = "00000000-0000-4000-8000-000000010005" as AppId;
const TRACE_BLOCK_REASON = "trace-block";
const TRACE_BLOCKED_TEXT = "blocked trace capture";
const TRACE_APP_MANIFEST: AppManifest = {
  appId: TRACE_APP_ID,
  name: "Trace Capture Test App",
  hooks: {
    message_authorize: { timeout_ms: 5_000 },
  },
};

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect({
        traceCaptureLayer: InMemoryTraceCaptureLive,
      });
      traceCapture = server.coreApp.traceCapture;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* resetTestDbEffect();
      yield* traceCapture.clear();
    }),
  ),
);

function attachBlockingMessageAuthorize(alice: ConnectedAgent) {
  return alice.client.onAppCallback(MessagesAuthorize, () =>
    Effect.succeed({
      verdict: { decision: "Block" as const, reason: TRACE_BLOCK_REASON },
    }),
  );
}

function expectHookBlocked(outcome: Either.Either<unknown, unknown>): void {
  Either.match(outcome, {
    onLeft: (error) => {
      expect((error as { code?: number }).code).toBe(HookBlockedError.code);
    },
    onRight: () => expect.fail("expected HookBlockedError"),
  });
}

function recordDeliveredMessageTrace(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-trace-capture");
    const bob = yield* registerAndConnect("bob-trace-capture");

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const conversationId = conv.conversation!.id;

    yield* alice.client.sendRpc(MessagesSend, {
      taskId: conv.task.id,
      conversationId,
      parts: [{ type: "text", text: "hello from trace capture test" }],
    });
    yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );

    const events = yield* traceCapture.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _tag: "Message",
      channelKey: conversationId,
      senderDisplayName: alice.name,
      recipientAgentIds: [bob.agentId],
      deliveredAgentIds: [bob.agentId],
      message: {
        conversationId,
        senderId: alice.agentId,
        parts: [{ type: "text", text: "hello from trace capture test" }],
      },
    });

    yield* alice.client.close();
    yield* bob.client.close();
  });
}

function recordBlockedHookTrace(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-trace-blocked");
    const bob = yield* registerAndConnect("bob-trace-blocked");
    // Wire the message-authorize callback BEFORE AppsRegister so the
    // server's forked round-trip lands on a live handler.
    yield* attachBlockingMessageAuthorize(alice);
    // Alice registers as TRACE_APP_ID's moderator so she can drive
    // TaskConversationCreate (TM-only).
    yield* alice.client.sendRpc(AppsRegister, { manifest: TRACE_APP_MANIFEST });
    yield* alice.client.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );

    const task = yield* alice.client.sendRpc(TaskRequest, {
      appId: TRACE_APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    const conv = yield* alice.client.sendRpc(TaskConversationCreate, {
      taskId: task.task.id,
      participants: [bob.agentId],
    });
    const outcome = yield* Effect.either(
      alice.client.sendRpc(MessagesSend, {
        taskId: task.task.id,
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: TRACE_BLOCKED_TEXT }],
      }),
    );
    expectHookBlocked(outcome);

    const events = yield* traceCapture.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _tag: "HookBlocked",
      hookName: "before_message_delivery",
      conversationId: conv.conversation.id,
      channelKey: conv.conversation.id,
      senderAgentId: alice.agentId,
      senderDisplayName: alice.name,
      reason: TRACE_BLOCK_REASON,
      parts: [{ type: "text", text: TRACE_BLOCKED_TEXT }],
    });

    yield* alice.client.close();
    yield* bob.client.close();
  });
}

describe("trace capture", () => {
  it("records delivered messages through the server DI capture", () =>
    recordDeliveredMessageTrace());

  it("records blocked before_message_delivery hooks", () =>
    recordBlockedHookTrace());
});
