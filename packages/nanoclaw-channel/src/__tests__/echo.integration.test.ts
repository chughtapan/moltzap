/**
 * Echo integration test for `@moltzap/nanoclaw-channel`.
 *
 * Boots `MoltZapAdapter` against a real MoltZap server (PGlite-backed,
 * spawned by the global setup), uses a peer `MoltZapService` to drive
 * inbound messages, and verifies the host-facing callbacks
 * (`setup.onInbound`, `setup.onMetadata`) fire with the expected shape
 * and `deliver(jid, null, message)` round-trips back to the peer.
 */

/* eslint-disable agent-code-guard/no-effect-error-coalescing -- test scaffolding coalesces wire-level Service/Rpc errors into a single test-context error class for cleaner diagnostic output; production rule does not apply to integration test scaffolding. */

import { afterAll, beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { MoltZapService } from "@moltzap/client";
import { withTestServiceConfig } from "@moltzap/client/test-utils";
import { AgentKey } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import { serverBaseUrl } from "@moltzap/protocol/network";
import { TaskRequest, DEFAULT_APP_ID } from "@moltzap/protocol/task";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { agentId as makeAgentId } from "@moltzap/protocol/testing";

import { MoltZapAdapter } from "../channels/moltzap.js";
import type {
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from "../channels/adapter.js";

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

interface InboundCapture {
  readonly jid: string;
  readonly msg: InboundMessage;
}

interface ChatMetadataCapture {
  readonly jid: string;
  readonly name?: string;
  readonly isGroup?: boolean;
}

interface Harness {
  readonly adapter: MoltZapAdapter;
  readonly peerService: MoltZapService;
  readonly inboundMessages: InboundCapture[];
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
const MOLTZAP_CHANNEL_NAME = "moltzap";
const JID_PREFIX = "mz:";
const OUTBOUND_KIND_CHAT = "chat";

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

function contentText(msg: InboundMessage): string {
  return (msg.content as { readonly text: string }).text;
}

function channelSenderId(agentId: string): string {
  return `${MOLTZAP_CHANNEL_NAME}:${agentId}`;
}

function makeOutbound(text: string): OutboundMessage {
  return { kind: OUTBOUND_KIND_CHAT, content: { text } };
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

function makeAdapter(
  config: InjectedConfig,
  inboundMessages: InboundCapture[],
  chatMetadata: ChatMetadataCapture[],
): Effect.Effect<MoltZapAdapter, unknown> {
  return Effect.gen(function* () {
    let adapter: MoltZapAdapter;
    const setup: ChannelSetup = {
      onInbound: (jid, _threadId, msg) => {
        inboundMessages.push({ jid, msg });
        autoEcho(adapter, jid, contentText(msg));
      },
      onMetadata: (jid, name, isGroup) => {
        chatMetadata.push({ jid, name, isGroup });
      },
    };
    adapter = MoltZapAdapter.fromProfile(CHANNEL_PROFILE_NAME, false);
    yield* withTestServiceConfig(
      {
        agentId: config.channelAgentId,
        agentKey: config.channelApiKey,
        serverUrl: config.wsUrl,
        profileName: CHANNEL_PROFILE_NAME,
        agentName: CHANNEL_PROFILE_NAME,
      },
      tryPromise("adapter.setup", () => adapter.setup(setup)),
    );
    return adapter;
  });
}

function autoEcho(adapter: MoltZapAdapter, jid: string, content: string): void {
  // Auto-echo failures (e.g. retries on a closed dispatch during teardown)
  // are absorbed: the host-facing test asserts at the peer-inbox boundary
  // so individual deliver failures do not invalidate the test. Modeled
  // as a fire-and-forget Effect (the simulated host responding to inbound).
  Effect.runFork(
    Effect.tryPromise({
      try: () =>
        adapter.deliver(jid, null, makeOutbound(`${ECHO_PREFIX}${content}`)),
      catch: noopOnError,
    }).pipe(Effect.ignore),
  );
}

function noopOnError(_cause: unknown): void {
  // Intentional no-op: auto-echo loop swallows transient failures.
}

function bootPeerService(
  config: InjectedConfig,
  peerInbox: Message[],
): Effect.Effect<MoltZapService, unknown> {
  return Effect.succeed(
    MoltZapService.fromConfig({
      agentId: config.peerAgentId,
      agentKey: config.peerApiKey,
      serverUrl: serverBaseUrl(config.wsUrl),
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
    const inboundMessages: InboundCapture[] = [];
    const chatMetadata: ChatMetadataCapture[] = [];
    const peerInbox: Message[] = [];
    const adapter = yield* makeAdapter(
      config,
      inboundMessages,
      chatMetadata,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new EchoIntegrationError({ operation: "makeAdapter", cause }),
      ),
    );
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
      adapter,
      peerService,
      inboundMessages,
      chatMetadata,
      peerInbox,
      taskId,
      conversationId,
      chatJid: `${JID_PREFIX}${conversationId}`,
      peerAgentId: config.peerAgentId,
      stop: () => stopAdapterAndPeer(adapter, peerService),
    };
  });
}

function stopAdapterAndPeer(
  adapter: MoltZapAdapter,
  peerService: MoltZapService,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => adapter.teardown(),
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
  return h.inboundMessages.some((c) => contentText(c.msg).includes(needle));
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
    "delivers inbound messages to the host onInbound callback",
    deliversInbound,
  );
  it("emits a chat-metadata event for the conversation", emitsChatMetadata);
  it("deliver round-trips back to the peer's inbox", roundTripsToPeer);
});

function deliversInbound() {
  return Effect.gen(function* () {
    yield* peerSend(PING_ONE);
    yield* waitFor(
      () => inboundHas(PING_ONE),
      INBOUND_NOTIFICATION_TIMEOUT_MS,
      "ping-one inbound",
    );
    const seen = h.inboundMessages.find((c) =>
      contentText(c.msg).includes(PING_ONE),
    );
    expect(seen?.jid).toBe(h.chatJid);
    expect((seen!.msg.content as { senderId: string }).senderId).toBe(
      channelSenderId(h.peerAgentId),
    );
  });
}

function emitsChatMetadata() {
  return Effect.sync(() => {
    expect(h.chatMetadata.some((m) => m.jid === h.chatJid)).toBe(true);
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
