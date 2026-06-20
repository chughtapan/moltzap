/**
 * E2E echo integration test (spec A11).
 *
 * The test boots the public `bootClaudeCodeChannel` entry against a real
 * MoltZap server from global setup, injects an in-memory MCP transport, and
 * drives inbound messages through a second MoltZapService peer.
 */

import { afterAll, beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { MoltZapService } from "@moltzap/client";
import type { ServiceRpcError } from "@moltzap/client";
import { withTestServiceConfig } from "@moltzap/client/test-utils";
import { AgentKey } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { agentId, waitUntil } from "@moltzap/protocol/testing";
import { bootClaudeCodeChannel } from "../entry.js";
import type { Handle } from "../types.js";
import { CLAUDE_CHANNEL_NOTIFICATION_METHOD } from "../types.js";

class EchoIntegrationError extends Data.TaggedError("EchoIntegrationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

interface InjectedConfig {
  readonly wsUrl: string;
  readonly agentAApiKey: AgentKey;
  readonly agentBApiKey: AgentKey;
  readonly channelAgentId: AgentId;
  readonly peerAgentId: AgentId;
}

interface Harness {
  readonly channelHandle: Handle;
  readonly peerService: MoltZapService;
  readonly mcpClient: Client;
  readonly channelAgentId: AgentId;
  readonly peerAgentId: AgentId;
  readonly notifications: Notification[];
  readonly peerInbox: Message[];
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

const HARNESS_BOOT_TIMEOUT_MS = 120_000;
const TEXT_TYPE = "text";
const STRING_TYPE = "string";
const PING_ONE = "ping-one";
const PONG_ONE = "pong-one";
const PONG_TWO = "pong-two";
const UNKNOWN_REPLY_TO = "unknown-message-id-xyz";
const SHOULD_ERROR_TEXT = "should-error";
const REPLY_TOOL_NAME = "reply";
const SERVER_NAME = "test-claude-code-channel";
const SERVER_INSTRUCTIONS = "integration test";
const CHANNEL_PROFILE_NAME = "channel-agent";
const MCP_CLIENT_NAME = "integration-test";
const MCP_CLIENT_VERSION = "0.1.0";
const REQUIRED_META_KEYS = ["chat_id", "message_id", "ts", "user"].sort();

let h: Harness;

const tryPromise = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, EchoIntegrationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new EchoIntegrationError({ operation, cause }),
  });

function injectedConfig(): InjectedConfig {
  return {
    wsUrl: injectString("moltzapWsUrl"),
    agentAApiKey: decodeInjectedAgentKey("agentAApiKey"),
    agentBApiKey: decodeInjectedAgentKey("agentBApiKey"),
    channelAgentId: agentId(injectString("agentAAgentId")),
    peerAgentId: agentId(injectString("agentBAgentId")),
  };
}

function injectString(key: keyof import("vitest").ProvidedContext): string {
  return inject(key);
}

function decodeInjectedAgentKey(
  key: keyof import("vitest").ProvidedContext,
): AgentKey {
  return Schema.decodeUnknownSync(AgentKey)(injectString(key));
}

function bootChannelHandle(
  config: InjectedConfig,
  serverTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0],
): Effect.Effect<Handle, EchoIntegrationError> {
  return withTestServiceConfig(
    {
      agentId: config.channelAgentId,
      agentKey: config.agentAApiKey,
      serverUrl: config.wsUrl,
      profileName: CHANNEL_PROFILE_NAME,
      agentName: CHANNEL_PROFILE_NAME,
    },
    Effect.tryPromise({
      try: () =>
        bootClaudeCodeChannel({
          profileName: CHANNEL_PROFILE_NAME,
          serverName: SERVER_NAME,
          instructions: SERVER_INSTRUCTIONS,
          _testTransportFactory: () => serverTransport,
        }),
      catch: (cause) =>
        new EchoIntegrationError({ operation: "bootClaudeCodeChannel", cause }),
    }).pipe(
      Effect.flatMap((boot) =>
        boot._tag === "Err"
          ? Effect.fail(
              new EchoIntegrationError({
                operation: "bootClaudeCodeChannel",
                cause: boot.error,
              }),
            )
          : Effect.succeed(boot.value),
      ),
    ),
  );
}

function makeMcpClient(notifications: Notification[]): Client {
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );
  client.fallbackNotificationHandler = (notification: Notification) => {
    notifications.push(notification);
    return Promise.resolve();
  };
  return client;
}

function makePeerService(
  config: InjectedConfig,
  peerInbox: Message[],
): Effect.Effect<MoltZapService, unknown> {
  return Effect.succeed(
    MoltZapService.fromConfig({
      agentId: config.peerAgentId,
      agentKey: config.agentBApiKey,
      serverUrl: config.wsUrl,
    }),
  ).pipe(
    Effect.tap((peerService) =>
      Effect.sync(() => {
        peerService.on("message", ({ message }) => {
          peerInbox.push(message);
        });
      }),
    ),
  );
}

function createPeerConversation(
  peerService: MoltZapService,
  channelAgentId: AgentId,
): Effect.Effect<
  { readonly taskId: TaskId; readonly conversationId: ConversationId },
  ServiceRpcError
> {
  return Effect.gen(function* () {
    const response = yield* peerService.call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [channelAgentId],
      initialConversation: { participants: [channelAgentId] },
    });
    return {
      taskId: response.task.id,
      conversationId: response.conversation!.id,
    };
  });
}

function bootHarness(): Effect.Effect<
  Harness,
  EchoIntegrationError | ServiceRpcError
> {
  return Effect.gen(function* () {
    const config = injectedConfig();
    const notifications: Notification[] = [];
    const peerInbox: Message[] = [];
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const channelHandle = yield* bootChannelHandle(config, serverTransport);
    const mcpClient = makeMcpClient(notifications);
    yield* tryPromise("mcpClient.connect", () =>
      mcpClient.connect(clientTransport),
    );

    const peerService = yield* makePeerService(config, peerInbox);
    yield* peerService.connect();
    const { taskId, conversationId } = yield* createPeerConversation(
      peerService,
      config.channelAgentId,
    );

    return {
      channelHandle,
      peerService,
      mcpClient,
      channelAgentId: config.channelAgentId,
      peerAgentId: config.peerAgentId,
      notifications,
      peerInbox,
      taskId,
      conversationId,
    };
  });
}

function ignoreStopError(
  operation: string,
): (error: unknown) => Effect.Effect<void> {
  return (error) =>
    Effect.logDebug("echo integration cleanup failed").pipe(
      Effect.annotateLogs({ operation, error }),
    );
}

function stopHarness(harness: Harness): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* tryPromise("mcpClient.close", () => harness.mcpClient.close()).pipe(
      Effect.catchAll(ignoreStopError("mcpClient.close")),
    );
    yield* harness.channelHandle
      .stop()
      .pipe(Effect.catchAll(ignoreStopError("channelHandle.stop")));
    yield* Effect.sync(() => {
      harness.peerService.close();
    });
  });
}

const textPart = (
  part: Message["parts"][number],
): part is { readonly type: "text"; readonly text: string } =>
  part.type === TEXT_TYPE;

const isChannelContent = (content: string) => (notification: Notification) =>
  notification.method === CLAUDE_CHANNEL_NOTIFICATION_METHOD &&
  (notification.params as { content?: string }).content === content;

function findNotificationByContent(content: string): Notification | undefined {
  return h.notifications.find(isChannelContent(content));
}

function peerSendsPingEmitsNotification() {
  return Effect.gen(function* () {
    yield* h.peerService.send(h.taskId, h.conversationId, PING_ONE);
    yield* waitUntil(() => h.notifications.some(isChannelContent(PING_ONE)));
    const notification = findNotificationByContent(PING_ONE);
    expect(notification).toBeDefined();
    const meta = (notification!.params as { meta: Record<string, unknown> })
      .meta;
    expect(Object.keys(meta).sort()).toEqual(REQUIRED_META_KEYS);
    expect(meta.chat_id).toBe(h.conversationId);
    expect(meta.user).toBe(h.peerAgentId);
    expect(typeof meta.message_id).toBe(STRING_TYPE);
    expect(typeof meta.ts).toBe(STRING_TYPE);
    expect("conversation_id" in meta).toBe(false);
    expect("sender_id" in meta).toBe(false);
    expect("received_at_ms" in meta).toBe(false);
  });
}

function everyNotificationUsesChannelMethod() {
  return Effect.sync(() => {
    const methods = new Set(h.notifications.map((n) => n.method));
    expect(methods).toEqual(new Set([CLAUDE_CHANNEL_NOTIFICATION_METHOD]));
  });
}

function replyWithoutReplyToRoutesToLastActiveChat() {
  return Effect.gen(function* () {
    const inboxBefore = h.peerInbox.length;
    const result = yield* tryPromise("mcpClient.callTool", () =>
      h.mcpClient.callTool({
        name: REPLY_TOOL_NAME,
        arguments: { text: PONG_ONE },
      }),
    );
    expect(result.isError).not.toBe(true);
    yield* waitUntil(() => h.peerInbox.length > inboxBefore);
    const newMsg = h.peerInbox[h.peerInbox.length - 1];
    expect(newMsg?.conversationId).toBe(h.conversationId);
    expect(newMsg?.parts.find(textPart)?.text).toBe(PONG_ONE);
  });
}

function replyWithKnownReplyToRoutesToThatChat() {
  return Effect.gen(function* () {
    const firstInbound = h.notifications.find(
      (n) => n.method === CLAUDE_CHANNEL_NOTIFICATION_METHOD,
    );
    expect(firstInbound).toBeDefined();
    const meta = (firstInbound!.params as { meta: { message_id: string } })
      .meta;

    const inboxBefore = h.peerInbox.length;
    const result = yield* tryPromise("mcpClient.callTool", () =>
      h.mcpClient.callTool({
        name: REPLY_TOOL_NAME,
        arguments: { text: PONG_TWO, reply_to: meta.message_id },
      }),
    );
    expect(result.isError).not.toBe(true);
    yield* waitUntil(() => h.peerInbox.length > inboxBefore);
    const newMsg = h.peerInbox[h.peerInbox.length - 1];
    expect(newMsg?.parts.find(textPart)?.text).toBe(PONG_TWO);
  });
}

function replyWithUnknownReplyToReturnsToolError() {
  return Effect.gen(function* () {
    const result = yield* tryPromise("mcpClient.callTool", () =>
      h.mcpClient.callTool({
        name: REPLY_TOOL_NAME,
        arguments: { text: SHOULD_ERROR_TEXT, reply_to: UNKNOWN_REPLY_TO },
      }),
    );
    expect(result.isError).toBe(true);
  });
}

beforeAll(
  () =>
    Effect.runPromise(
      bootHarness().pipe(
        Effect.tap((harness) =>
          Effect.sync(() => {
            h = harness;
          }),
        ),
      ),
    ),
  HARNESS_BOOT_TIMEOUT_MS,
);

afterAll(() => Effect.runPromise(stopHarness(h)));

describe("echo integration inbound notifications", () => {
  it(
    "peer sends ping and channel emits notification with contract meta keys",
    peerSendsPingEmitsNotification,
  );
  it(
    "every emitted notification method equals the channel method",
    everyNotificationUsesChannelMethod,
  );
});

describe("echo integration reply routing", () => {
  it(
    "reply tool without reply_to routes to last-active chat",
    replyWithoutReplyToRoutesToLastActiveChat,
  );
  it(
    "reply tool with known reply_to routes to that chat",
    replyWithKnownReplyToRoutesToThatChat,
  );
  it(
    "reply tool with unknown reply_to returns a tool error",
    replyWithUnknownReplyToReturnsToolError,
  );
});
