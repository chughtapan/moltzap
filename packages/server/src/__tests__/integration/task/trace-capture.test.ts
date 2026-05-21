import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Either } from "effect";

import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getTestCoreApp,
} from "../helpers.js";
import {
  InMemoryTraceCaptureLive,
  type TraceCapture,
} from "../../../runtime-surface/trace-capture.js";
import {
  DEFAULT_APP_ID,
  HookBlockedError,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskConversationCreate,
  TaskCreate,
  type AppManifest,
} from "@moltzap/protocol";
import { endpointAddress } from "@moltzap/protocol/network";

let traceCapture: TraceCapture;
const TRACE_APP_ID = "trace-capture-test-app";
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
      yield* Effect.sync(() => {
        getTestCoreApp().registerApp(TRACE_APP_MANIFEST);
      });
    }),
  ),
);

function registerBlockingMessageAuthorize(agentId: string): void {
  getTestCoreApp().registerMessageAuthorize(
    endpointAddress(`tm:agent:${agentId}`),
    () => ({ decision: "Block", reason: TRACE_BLOCK_REASON }),
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

    const conv = yield* alice.client.sendRpc(TaskCreate, {
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
    registerBlockingMessageAuthorize(alice.agentId);

    const task = yield* alice.client.sendRpc(TaskCreate, {
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
