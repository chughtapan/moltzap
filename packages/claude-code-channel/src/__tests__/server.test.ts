/**
 * Unit tests for `server.ts` — MCP stdio server behavior exercised through
 * the SDK's `InMemoryTransport` pair.
 */

import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect, Either } from "effect";
import { ForbiddenError } from "@moltzap/protocol";

import {
  CHANNEL_CAPABILITIES,
  decodeReplyArgs,
  REPLY_TOOL_INPUT_SCHEMA,
} from "../server.js";
import { brandIsoTimestamp } from "../event.js";
import type { ClaudeChannelNotification } from "../types.js";
import {
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  ConversationId,
  MessageId,
  TaskId,
  UserId,
} from "../types.js";
import type { RoutingTarget } from "../routing.js";
import {
  LeaseAlreadyConsumed,
  SendFailed,
  type ReplyError,
} from "../errors.js";
import {
  callTool,
  listTools,
  waitForTransportTick,
  withHarness,
  type ServerHarness,
} from "./server-test-support.js";

type SentReply = { readonly conversationId: string; readonly text: string };

const effectTest = effectIt.effect;

const CONVERSATION_1 = "00000000-0000-4000-8000-0000000000a1";
const CONVERSATION_2 = "00000000-0000-4000-8000-0000000000a2";
const CONVERSATION_KNOWN = "00000000-0000-4000-8000-0000000000a3";
const CONVERSATION_X = "00000000-0000-4000-8000-0000000000a4";
const MESSAGE_1 = "00000000-0000-4000-8000-0000000001a1";
const MESSAGE_2 = "00000000-0000-4000-8000-0000000001a2";
const MESSAGE_KNOWN = "00000000-0000-4000-8000-0000000001a3";
const MESSAGE_MISSING = "00000000-0000-4000-8000-0000000001a4";
const MESSAGE_X = "00000000-0000-4000-8000-0000000001a5";
const USER_PEER = "00000000-0000-4000-8000-0000000002a1";
const TASK_ID = "00000000-0000-4000-8000-0000000003a1";
const REPLY_TOOL_NAME = "reply";
const REPLY_TEXT = "hi";
const SECOND_REPLY_TEXT = "second reply attempt";
const TEXT_TYPE = "string";
const OBJECT_TYPE = "object";
const ARRAY_TYPE = "array";
const PING_TEXT = "ping";
const TIMESTAMP = "2026-04-24T00:00:00Z";
const FILE_A = "a.png";
const FILE_B = "b.png";
const LEASE_ID = "lease-cc-test";
const LEASE_CONSUMED_AT = 1_700_000_000_000;
const LEASE_FORBIDDEN_MESSAGE = "lease consumed";

const EXPECTED_CHANNEL_CAPABILITIES = {
  tools: {},
  experimental: { "claude/channel": {} },
};

const EXPECTED_REPLY_INPUT_SCHEMA = {
  type: OBJECT_TYPE,
  properties: {
    text: { type: TEXT_TYPE },
    reply_to: { type: TEXT_TYPE },
    files: { type: ARRAY_TYPE, items: { type: TEXT_TYPE } },
  },
  required: ["text"],
};

function makeNotification(
  conversationId: string,
  messageId: string,
): ClaudeChannelNotification {
  return {
    method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
    params: {
      content: PING_TEXT,
      meta: {
        chat_id: ConversationId(conversationId),
        message_id: MessageId(messageId),
        user: UserId(USER_PEER),
        ts: brandIsoTimestamp(TIMESTAMP),
      },
    },
  };
}

function expectDecodeSuccess(raw: unknown) {
  return Either.match(decodeReplyArgs(raw), {
    onLeft: (error) => {
      expect(error).toBeUndefined();
      return undefined;
    },
    onRight: (value) => value,
  });
}

function expectDecodeFailure(raw: unknown): void {
  Either.match(decodeReplyArgs(raw), {
    onLeft: (error) => expect(error).toBeDefined(),
    onRight: (value) => expect(value).toBeUndefined(),
  });
}

function recordInboundPair(
  harness: ServerHarness,
  messageId: string,
  conversationId: string,
): void {
  harness.routing.recordInbound(MessageId(messageId), {
    taskId: TaskId(TASK_ID),
    conversationId: ConversationId(conversationId),
  });
}

function sentRecorder(sent: SentReply[]) {
  return (
    target: RoutingTarget,
    text: string,
  ): Effect.Effect<void, ReplyError> =>
    Effect.sync(() => {
      sent.push({ conversationId: target.conversationId, text });
    });
}

function advertisesChannelCapabilityContract() {
  return withHarness((harness) =>
    Effect.sync(() => {
      const caps = harness.client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.tools).toEqual(CHANNEL_CAPABILITIES.tools);
      expect(caps?.experimental).toEqual(CHANNEL_CAPABILITIES.experimental);
    }),
  );
}

function doesNotAdvertisePermissionRelay() {
  return withHarness((harness) =>
    Effect.sync(() => {
      expect(
        harness.client.getServerCapabilities()?.experimental,
      ).not.toHaveProperty("claude/channel/permission");
    }),
  );
}

function registersExactlyOneReplyTool() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      const result = yield* listTools(harness.client);
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]?.name).toBe(REPLY_TOOL_NAME);
    }),
  );
}

function replyInputSchemaMatchesContract() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      const result = yield* listTools(harness.client);
      const reply = result.tools.find((tool) => tool.name === REPLY_TOOL_NAME);
      expect(reply).toBeDefined();
      expect(reply?.inputSchema).toMatchObject(REPLY_TOOL_INPUT_SCHEMA);
    }),
  );
}

function emitsChannelMethodWithContractMeta() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      yield* harness.serverHandle.push(
        makeNotification(CONVERSATION_1, MESSAGE_1),
      );
      yield* waitForTransportTick();
      expect(harness.notifications).toHaveLength(1);
      const notification = harness.notifications[0];
      expect(notification).toBeDefined();
      expect(notification!.method).toBe(CLAUDE_CHANNEL_NOTIFICATION_METHOD);
      expect((notification!.params as { meta: unknown }).meta).toMatchObject({
        chat_id: CONVERSATION_1,
        message_id: MESSAGE_1,
        user: USER_PEER,
        ts: TIMESTAMP,
      });
    }),
  );
}

function pushEmitsOnlyChannelNotificationMethod() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      yield* harness.serverHandle.push(
        makeNotification(CONVERSATION_1, MESSAGE_1),
      );
      yield* harness.serverHandle.push(
        makeNotification(CONVERSATION_2, MESSAGE_2),
      );
      yield* waitForTransportTick();
      expect(new Set(harness.notifications.map((n) => n.method))).toEqual(
        new Set([CLAUDE_CHANNEL_NOTIFICATION_METHOD]),
      );
    }),
  );
}

function replyToPresentAndKnownSendsToMessageChat() {
  const sent: SentReply[] = [];
  return withHarness(assertReplyToPresentAndKnown(sent), {
    onSendReply: sentRecorder(sent),
  });
}

function assertReplyToPresentAndKnown(sent: SentReply[]) {
  return (harness: ServerHarness) =>
    Effect.gen(function* () {
      recordInboundPair(harness, MESSAGE_1, CONVERSATION_1);
      recordInboundPair(harness, MESSAGE_2, CONVERSATION_2);
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: { text: REPLY_TEXT, reply_to: MESSAGE_1 },
      });
      expect(result.isError).not.toBe(true);
      expect(sent).toEqual([
        { conversationId: CONVERSATION_1, text: REPLY_TEXT },
      ]);
    });
}

function replyToAbsentSendsToLastActiveChat() {
  const sent: SentReply[] = [];
  return withHarness(assertReplyToAbsent(sent), {
    onSendReply: sentRecorder(sent),
  });
}

function assertReplyToAbsent(sent: SentReply[]) {
  return (harness: ServerHarness) =>
    Effect.gen(function* () {
      recordInboundPair(harness, MESSAGE_1, CONVERSATION_1);
      recordInboundPair(harness, MESSAGE_2, CONVERSATION_2);
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: { text: REPLY_TEXT },
      });
      expect(result.isError).not.toBe(true);
      expect(sent).toEqual([
        { conversationId: CONVERSATION_2, text: REPLY_TEXT },
      ]);
    });
}

function emptyFilesArrayIsEquivalentToOmitted() {
  const sent: SentReply[] = [];
  return withHarness(assertEmptyFilesArray(sent), {
    onSendReply: sentRecorder(sent),
  });
}

function assertEmptyFilesArray(sent: SentReply[]) {
  return (harness: ServerHarness) =>
    Effect.gen(function* () {
      recordInboundPair(harness, MESSAGE_1, CONVERSATION_1);
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: { text: REPLY_TEXT, reply_to: MESSAGE_1, files: [] },
      });
      expect(result.isError).not.toBe(true);
      expect(sent).toEqual([
        { conversationId: CONVERSATION_1, text: REPLY_TEXT },
      ]);
    });
}

function returnsToolErrorWithoutActiveConversation() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: { text: REPLY_TEXT },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/no active conversation/);
    }),
  );
}

function returnsToolErrorWhenReplyToIsUnknown() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      recordInboundPair(harness, MESSAGE_KNOWN, CONVERSATION_KNOWN);
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: { text: REPLY_TEXT, reply_to: MESSAGE_MISSING },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        new RegExp(MESSAGE_MISSING),
      );
    }),
  );
}

function neverSilentlyDropsCallsWithoutRoutingState() {
  return withHarness((harness) =>
    Effect.gen(function* () {
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: {},
      });
      expect(result.isError).toBe(true);
    }),
  );
}

function rejectsNonEmptyFilesWithoutSending() {
  const sent: SentReply[] = [];
  return withHarness(assertRejectsNonEmptyFiles(sent), {
    onSendReply: sentRecorder(sent),
  });
}

function assertRejectsNonEmptyFiles(sent: SentReply[]) {
  return (harness: ServerHarness) =>
    Effect.gen(function* () {
      recordInboundPair(harness, MESSAGE_1, CONVERSATION_1);
      const result = yield* callTool(harness.client, {
        name: REPLY_TOOL_NAME,
        arguments: {
          text: REPLY_TEXT,
          reply_to: MESSAGE_1,
          files: [FILE_A, FILE_B],
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/FilesUnsupported/);
      expect(sent).toEqual([]);
    });
}

function surfacesSendFailedAsToolError() {
  return withHarness(assertSendFailed, {
    onSendReply: () =>
      Effect.fail<ReplyError>(new SendFailed({ cause: "ws dropped" })),
  });
}

function assertSendFailed(harness: ServerHarness) {
  return Effect.gen(function* () {
    recordInboundPair(harness, MESSAGE_X, CONVERSATION_X);
    const result = yield* callTool(harness.client, {
      name: REPLY_TOOL_NAME,
      arguments: { text: REPLY_TEXT },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/ws dropped/);
  });
}

function surfacesLeaseAlreadyConsumedAsStructuredToolError() {
  return withHarness(assertLeaseAlreadyConsumed, {
    onSendReply: () =>
      Effect.fail<ReplyError>(
        new LeaseAlreadyConsumed({
          leaseId: LEASE_ID,
          consumedAt: LEASE_CONSUMED_AT,
          cause: new ForbiddenError({
            message: LEASE_FORBIDDEN_MESSAGE,
            data: { reason: "LeaseInvalid" },
          }),
          message: LEASE_FORBIDDEN_MESSAGE,
        }),
      ),
  });
}

function assertLeaseAlreadyConsumed(harness: ServerHarness) {
  return Effect.gen(function* () {
    recordInboundPair(harness, MESSAGE_X, CONVERSATION_X);
    const result = yield* callTool(harness.client, {
      name: REPLY_TOOL_NAME,
      arguments: { text: SECOND_REPLY_TEXT },
    });
    expect(result.isError).toBe(true);
    const serialized = JSON.stringify(result.content);
    expect(serialized).toMatch(/LeaseAlreadyConsumed/);
    expect(serialized).toMatch(new RegExp(LEASE_ID));
  });
}

describe("bootChannelMcpServer capability handshake", () => {
  effectTest(
    "advertises the channel capability contract",
    advertisesChannelCapabilityContract,
  );

  effectTest(
    "does not advertise permission relay capabilities",
    doesNotAdvertisePermissionRelay,
  );

  it("CHANNEL_CAPABILITIES constant is the contract shape", () => {
    expect(CHANNEL_CAPABILITIES).toEqual(EXPECTED_CHANNEL_CAPABILITIES);
  });
});

describe("bootChannelMcpServer reply tool registry", () => {
  effectTest("registers exactly one reply tool", registersExactlyOneReplyTool);
  effectTest(
    "reply.inputSchema matches the contract",
    replyInputSchemaMatchesContract,
  );

  it("REPLY_TOOL_INPUT_SCHEMA is the exported contract shape", () => {
    expect(REPLY_TOOL_INPUT_SCHEMA).toMatchObject(EXPECTED_REPLY_INPUT_SCHEMA);
  });
});

describe("notification emission", () => {
  effectTest(
    "Handle.push emits the channel method with contract meta",
    emitsChannelMethodWithContractMeta,
  );
  effectTest(
    "push emits only the channel notification method",
    pushEmitsOnlyChannelNotificationMethod,
  );
});

describe("reply tool routing success cases", () => {
  effectTest(
    "reply_to present and known sends to that message chat",
    replyToPresentAndKnownSendsToMessageChat,
  );
  effectTest(
    "reply_to absent sends to last-active chat",
    replyToAbsentSendsToLastActiveChat,
  );
  effectTest(
    "empty files array is equivalent to omitted",
    emptyFilesArrayIsEquivalentToOmitted,
  );
});

describe("reply tool routing error cases", () => {
  effectTest(
    "returns tool error without an active conversation",
    returnsToolErrorWithoutActiveConversation,
  );
  effectTest(
    "returns tool error when reply_to is unknown",
    returnsToolErrorWhenReplyToIsUnknown,
  );
  effectTest(
    "never silently drops calls without routing state",
    neverSilentlyDropsCallsWithoutRoutingState,
  );
});

describe("reply tool file and lease errors", () => {
  effectTest(
    "rejects non-empty files without sending",
    rejectsNonEmptyFilesWithoutSending,
  );
  effectTest(
    "surfaces SendFailed as a tool error",
    surfacesSendFailedAsToolError,
  );
  effectTest(
    "surfaces LeaseAlreadyConsumed as a structured tool error",
    surfacesLeaseAlreadyConsumedAsStructuredToolError,
  );
});

describe("decodeReplyArgs valid inputs", () => {
  it("accepts text only", () => {
    const decoded = expectDecodeSuccess({ text: REPLY_TEXT });
    expect(decoded?.text).toBe(REPLY_TEXT);
    expect(decoded?.replyTo).toBeUndefined();
    expect(decoded?.files).toBeUndefined();
  });

  it("preserves text, reply_to, and files for the handler", () => {
    const decoded = expectDecodeSuccess({
      text: REPLY_TEXT,
      reply_to: MESSAGE_1,
      files: [FILE_A],
    });
    expect(decoded?.text).toBe(REPLY_TEXT);
    expect(decoded?.replyTo).toBe(MESSAGE_1);
    expect(decoded?.files).toEqual([FILE_A]);
  });
});

describe("decodeReplyArgs invalid text inputs", () => {
  it("rejects numeric text", () => {
    expectDecodeFailure({ text: 42 });
  });

  it("rejects missing text", () => {
    expectDecodeFailure({});
  });

  it("rejects empty-string text", () => {
    expectDecodeFailure({ text: "   " });
  });
});

describe("decodeReplyArgs invalid optional inputs", () => {
  it("rejects non-string file entries", () => {
    expectDecodeFailure({ text: REPLY_TEXT, files: [FILE_A, 1] });
  });

  it("rejects non-object input", () => {
    expectDecodeFailure(null);
  });

  it("rejects empty reply_to", () => {
    expectDecodeFailure({ text: REPLY_TEXT, reply_to: "" });
  });
});
