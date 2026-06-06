/**
 * Echo integration test for `@moltzap/nanoclaw-channel`.
 *
 * Boots `MoltZapChannel` against a real MoltZap server (PGlite-backed,
 * spawned by the global setup), uses a peer `MoltZapService` to drive
 * inbound messages, and verifies the host-facing callbacks
 * (`opts.onMessage`, `opts.onChatMetadata`) fire with the expected shape
 * and `sendMessage(jid, text)` round-trips back to the peer.
 *
 * Modeled on `packages/claude-code-channel/src/__tests__/echo.integration.test.ts`
 * (per arch sub-issue #605 §4.4).
 */

/* eslint-disable agent-code-guard/no-effect-error-coalescing -- test scaffolding coalesces wire-level Service/Rpc errors into a single test-context error class for cleaner diagnostic output; production rule does not apply to integration test scaffolding. */

import { afterAll, beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { MoltZapService } from "@moltzap/client";
import { withTestServiceConfig } from "@moltzap/client/test-utils";
import { AgentKey } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import { TaskRequest, DEFAULT_APP_ID } from "@moltzap/protocol/task";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { agentId as makeAgentId } from "@moltzap/protocol/testing";

import { makeMoltZapChannel, MoltZapChannel } from "../channels/moltzap.js";
import type { ChannelOpts } from "../channels/registry.js";
import type { NewMessage, RegisteredGroup } from "../types.js";

class EchoIntegrationError extends Data.TaggedError("EchoIntegrationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

interface InjectedConfig {
  readonly wsUrl: string;
  readonly channelApiKey: AgentKey;
  readonly peerApiKey: AgentKey;
  readonly channelAgentId: AgentId;
  readonly peerAgentId: AgentId;
}

interface ChatMetadataCapture {
  readonly chatJid: string;
  readonly timestamp: string;
  readonly name?: string;
  readonly channel?: string;
  readonly isGroup?: boolean;
}

interface Harness {
  readonly channel: MoltZapChannel;
  readonly peerService: MoltZapService;
  readonly inboundMessages: NewMessage[];
  readonly chatMetadata: ChatMetadataCapture[];
  readonly peerInbox: Message[];
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly chatJid: string;
  readonly peerAgentId: string;
  readonly stop: () => PromiseLike<void>;
}

const WAIT_FOR_TICK_MS = 25;
const INBOUND_NOTIFICATION_TIMEOUT_MS = 15_000;
const PING_ONE = "ping-one";
const PING_TWO = "ping-two";
const TEXT_TYPE = "text";
const ECHO_PREFIX = "echo-";
const CHANNEL_PROFILE_NAME = "channel-agent";

let h: Harness;

function injectString(key: string): string {
  return inject(key as never) as string;
}

function injectedConfig(): InjectedConfig {
  return {
    wsUrl: injectString("moltzapWsUrl"),
    channelApiKey: decodeInjectedAgentKey("agentAApiKey"),
    peerApiKey: decodeInjectedAgentKey("agentBApiKey"),
    channelAgentId: makeAgentId(injectString("agentAAgentId")),
    peerAgentId: makeAgentId(injectString("agentBAgentId")),
  };
}

function decodeInjectedAgentKey(key: string): AgentKey {
  return Schema.decodeUnknownSync(AgentKey)(injectString(key));
}

function tryPromise<A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, EchoIntegrationError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new EchoIntegrationError({ operation, cause }),
  });
}

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Effect.Effect<void, EchoIntegrationError> {
  return Effect.tryPromise({
    try: () => waitForPromise(predicate, timeoutMs, label),
    catch: (cause) =>
      new EchoIntegrationError({ operation: `waitFor(${label})`, cause }),
  });
}

function waitForPromise(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor(${label}) timed out`));
        return;
      }
      setTimeout(tick, WAIT_FOR_TICK_MS);
    };
    tick();
  });
}

function makeChannel(
  config: InjectedConfig,
  inboundMessages: NewMessage[],
  chatMetadata: ChatMetadataCapture[],
): Effect.Effect<MoltZapChannel, unknown> {
  return Effect.gen(function* () {
    let channel: MoltZapChannel;
    const opts: ChannelOpts = {
      onMessage: (chatJid, msg) => {
        inboundMessages.push(msg);
        autoEcho(channel, chatJid, msg.content);
      },
      onChatMetadata: (meta) => {
        chatMetadata.push(meta);
      },
      registeredGroups: emptyRegisteredGroups,
    };
    channel = yield* withTestServiceConfig(
      {
        agentId: config.channelAgentId,
        agentKey: config.channelApiKey,
        serverUrl: config.wsUrl,
        profileName: CHANNEL_PROFILE_NAME,
        agentName: CHANNEL_PROFILE_NAME,
      },
      makeMoltZapChannel({ ...opts, profileName: CHANNEL_PROFILE_NAME }, false),
    );
    return channel;
  });
}

function autoEcho(
  channel: MoltZapChannel,
  chatJid: string,
  content: string,
): void {
  // Auto-echo failures (e.g. retries on a closed dispatch during teardown)
  // are absorbed: the host-facing test asserts at the peer-inbox boundary
  // so individual sendMessage failures do not invalidate the test. Modeled
  // as a fire-and-forget Effect (the simulated host responding to inbound).
  Effect.runFork(
    Effect.tryPromise({
      try: () => channel.sendMessage(chatJid, `${ECHO_PREFIX}${content}`),
      catch: noopOnError,
    }).pipe(Effect.ignore),
  );
}

function noopOnError(_cause: unknown): void {
  // Intentional no-op: auto-echo loop swallows transient failures.
}

function emptyRegisteredGroups(): Record<string, RegisteredGroup> {
  return {};
}

function bootPeerService(
  config: InjectedConfig,
  peerInbox: Message[],
): Effect.Effect<MoltZapService, unknown> {
  return Effect.succeed(
    MoltZapService.fromConfig({
      agentId: config.peerAgentId,
      agentKey: config.peerApiKey,
      serverUrl: config.wsUrl,
    }),
  ).pipe(
    Effect.tap((peerService) =>
      Effect.sync(() => {
        peerService.on("message", ({ message: msg }) => {
          peerInbox.push(msg);
        });
      }),
    ),
  );
}

function createDm(
  peerService: MoltZapService,
  channelAgentId: AgentId,
): Effect.Effect<
  { taskId: TaskId; conversationId: ConversationId },
  EchoIntegrationError
> {
  return peerService
    .call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [channelAgentId],
      initialConversation: { participants: [channelAgentId] },
    })
    .pipe(
      Effect.map((res) => {
        const r = res as {
          task: { id: TaskId };
          conversation: { id: ConversationId } | null;
        };
        return {
          taskId: r.task.id,
          conversationId: r.conversation!.id,
        };
      }),
      Effect.mapError(
        (cause) => new EchoIntegrationError({ operation: "createDm", cause }),
      ),
    );
}

function connectPeerService(
  peerService: MoltZapService,
): Effect.Effect<void, EchoIntegrationError> {
  return peerService.connect().pipe(
    Effect.mapError(
      (cause) =>
        new EchoIntegrationError({
          operation: "peerService.connect",
          cause,
        }),
    ),
  );
}

function makeHarness(
  config: InjectedConfig,
): Effect.Effect<Harness, EchoIntegrationError> {
  return Effect.gen(function* () {
    const inboundMessages: NewMessage[] = [];
    const chatMetadata: ChatMetadataCapture[] = [];
    const peerInbox: Message[] = [];
    const channel = yield* makeChannel(
      config,
      inboundMessages,
      chatMetadata,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new EchoIntegrationError({ operation: "makeChannel", cause }),
      ),
    );
    yield* tryPromise("channel.connect", () => channel.connect());
    const peerService = yield* bootPeerService(config, peerInbox).pipe(
      Effect.mapError(
        (cause) =>
          new EchoIntegrationError({ operation: "bootPeerService", cause }),
      ),
    );
    yield* connectPeerService(peerService);
    const { taskId, conversationId } = yield* createDm(
      peerService,
      config.channelAgentId,
    );
    return {
      channel,
      peerService,
      inboundMessages,
      chatMetadata,
      peerInbox,
      taskId,
      conversationId,
      chatJid: `mz:${conversationId}`,
      peerAgentId: config.peerAgentId,
      stop: () => stopChannelAndPeer(channel, peerService),
    };
  });
}

function stopChannelAndPeer(
  channel: MoltZapChannel,
  peerService: MoltZapService,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => channel.disconnect(),
        catch: () => undefined,
      }).pipe(Effect.ignore);
      peerService.close();
    }),
  );
}

beforeAll(() => Effect.runPromise(initHarness()));
afterAll(() => stopHarness());

function initHarness() {
  return Effect.gen(function* () {
    h = yield* makeHarness(injectedConfig());
  });
}

function stopHarness() {
  return h === undefined ? Promise.resolve() : h.stop();
}

function messageContains(message: Message, needle: string): boolean {
  return message.parts.some(
    (part) => part.type === TEXT_TYPE && part.text.includes(needle),
  );
}

function inboundHas(needle: string): boolean {
  return h.inboundMessages.some((m) => m.content.includes(needle));
}

function peerInboxHas(needle: string): boolean {
  return h.peerInbox.some((m) => messageContains(m, needle));
}

function peerSend(text: string): Effect.Effect<void, EchoIntegrationError> {
  return h.peerService
    .send(h.taskId, h.conversationId, text)
    .pipe(
      Effect.mapError(
        (cause) =>
          new EchoIntegrationError({ operation: "peerService.send", cause }),
      ),
    );
}

describe("nanoclaw echo integration", () => {
  it(
    "delivers inbound messages to the host onMessage callback",
    deliversInbound,
  );
  it("emits a chat-metadata event for the conversation", emitsChatMetadata);
  it("sendMessage round-trips back to the peer's inbox", roundTripsToPeer);
});

function deliversInbound() {
  return Effect.gen(function* () {
    yield* peerSend(PING_ONE);
    yield* waitFor(
      () => inboundHas(PING_ONE),
      INBOUND_NOTIFICATION_TIMEOUT_MS,
      "ping-one inbound",
    );
    const seen = h.inboundMessages.find((m) => m.content.includes(PING_ONE));
    expect(seen?.chat_jid).toBe(h.chatJid);
    expect(seen?.sender).toBe(h.peerAgentId);
  });
}

function emitsChatMetadata() {
  return Effect.sync(() => {
    expect(h.chatMetadata.some((m) => m.chatJid === h.chatJid)).toBe(true);
  });
}

function roundTripsToPeer() {
  return Effect.gen(function* () {
    yield* peerSend(PING_TWO);
    yield* waitFor(
      () => peerInboxHas(`${ECHO_PREFIX}${PING_TWO}`),
      INBOUND_NOTIFICATION_TIMEOUT_MS,
      "echo-pong-two on peer",
    );
    expect(peerInboxHas(`${ECHO_PREFIX}${PING_TWO}`)).toBe(true);
  });
}
