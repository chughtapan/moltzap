/**
 * Echo integration test for `@moltzap/nanoclaw-channel`.
 *
 * Drives the adapter nanoclaw itself registers: the production factory, which
 * resolves a profile slot into its own `moltzapd` child, the loopback MCP
 * endpoint the slot names, and a file-backed checkpoint store. A peer agent
 * on the same server (PGlite-backed, spawned by the global setup) opens a DM
 * and sends into it, so the assertions cover the whole path — daemon startup,
 * turn projection, the host-facing callbacks, and `deliver` back to the peer.
 */

import { describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import {
  Data,
  Deferred,
  Effect,
  Fiber,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { MoltZapAgentClient } from "@moltzap/client";
import {
  reserveTestMcpPort,
  withTestServiceConfig,
} from "@moltzap/client/test-utils";
import {
  type AgentKey,
  agentKey,
  type AgentId,
} from "@moltzap/protocol/identity";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
  type Message,
} from "@moltzap/protocol/message";
import { agentConversationCreate } from "@moltzap/protocol/conversation";
import { agentId as makeAgentId } from "@moltzap/protocol/testing";

import {
  makeMoltZapAdapter,
  type MoltZapAdapter,
} from "../channels/moltzap.js";
import type {
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from "../channels/adapter.js";

/** The production factory refused the profile slot this suite just wrote. */
class MissingAdapterError extends Data.TaggedError("MissingAdapterError")<
  Record<never, never>
> {
  override get message(): string {
    return "the production factory returned no adapter";
  }
}

interface InjectedConfig {
  readonly baseUrl: string;
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

const REPLY_TIMEOUT = "20 seconds";
const PING = "ping-one";
const TEXT_TYPE = "text";
const ECHO_PREFIX = "echo-";
const CHANNEL_PROFILE_NAME = "channel-agent";
const MOLTZAP_CHANNEL_NAME = "moltzap";
const JID_PREFIX = "mz:";
const OUTBOUND_KIND_CHAT = "chat";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const tryPromise = <A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: evaluate, catch: toError });

function injectString(key: string): string {
  return inject(
    /* Safe because the test fixture establishes this asserted shape. */ key as never,
  );
}

function decodeInjectedAgentKey(key: string): AgentKey {
  return Schema.decodeUnknownSync(agentKey)(injectString(key));
}

function injectedConfig(): InjectedConfig {
  return {
    baseUrl: injectString("moltzapBaseUrl"),
    channelApiKey: decodeInjectedAgentKey("agentAApiKey"),
    peerApiKey: decodeInjectedAgentKey("agentBApiKey"),
    channelAgentId: makeAgentId(injectString("agentAAgentId")),
    peerAgentId: makeAgentId(injectString("agentBAgentId")),
  };
}

function contentText(msg: InboundMessage): string {
  return (
    /* Safe because the test fixture establishes this asserted shape. */
    (msg.content as { readonly text: string }).text
  );
}

function senderIdOf(msg: InboundMessage): string {
  return (
    /* Safe because the test fixture establishes this asserted shape. */
    (msg.content as { readonly senderId: string }).senderId
  );
}

function makeOutbound(text: string): OutboundMessage {
  return { kind: OUTBOUND_KIND_CHAT, content: { text } };
}

function messageText(message: Message): string {
  return message.parts
    .flatMap((part) => (part.type === TEXT_TYPE ? [part.text] : []))
    .join("");
}

/**
 * Nanoclaw's host contract: the router calls `deliver` from its own turn
 * handling, so the echo runs inside `onInbound` exactly where a session's
 * model output would.
 * @param adapter Adapter under test.
 * @param inbound Resolved with the first host-facing inbound message.
 * @param metadata Chat-metadata events observed for the conversation.
 * @returns The setup nanoclaw would install.
 */
function echoSetup(
  adapter: MoltZapAdapter,
  inbound: Deferred.Deferred<InboundCapture>,
  metadata: ChatMetadataCapture[],
): ChannelSetup {
  return {
    onInbound: (...[jid, , msg]) => {
      Effect.runSync(Deferred.succeed(inbound, { jid, msg }));
      return adapter.deliver(
        jid,
        null,
        makeOutbound(`${ECHO_PREFIX}${contentText(msg)}`),
      );
    },
    onMetadata: (jid, name, isGroup) => {
      metadata.push({ jid, name, isGroup });
    },
  };
}

function acquireAdapter(
  inbound: Deferred.Deferred<InboundCapture>,
  metadata: ChatMetadataCapture[],
): Effect.Effect<MoltZapAdapter, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const adapter = makeMoltZapAdapter({
        profileName: CHANNEL_PROFILE_NAME,
        evalMode: false,
      });
      if (adapter === null) {
        return new MissingAdapterError();
      }
      return tryPromise(() =>
        adapter.setup(echoSetup(adapter, inbound, metadata)),
      ).pipe(Effect.as(adapter));
    }),
    (adapter) => tryPromise(() => adapter.teardown()).pipe(Effect.ignore),
  );
}

function acquirePeer(
  config: InjectedConfig,
): Effect.Effect<MoltZapAgentClient, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const peer = new MoltZapAgentClient({
        serverUrl: config.baseUrl,
        agentKey: config.peerApiKey,
      });
      return peer.connect().pipe(Effect.mapError(toError), Effect.as(peer));
    }),
    (peer) => peer.close().pipe(Effect.ignore),
  );
}

function takeChannelReply(
  peer: MoltZapAgentClient,
  config: InjectedConfig,
  conversationId: string,
): Effect.Effect<Message, Error> {
  return peer.subscribe(messageReceivedNotificationDefinition).pipe(
    Stream.filter(
      ({ message }) =>
        message.senderId === config.channelAgentId &&
        message.conversationId === conversationId,
    ),
    Stream.runHead,
    Effect.timeoutFail({
      duration: REPLY_TIMEOUT,
      onTimeout: () => new Error("timed out waiting for the adapter echo"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new Error("peer reply stream closed before delivery")),
        onSome: ({ message }) => Effect.succeed(message),
      }),
    ),
    Effect.mapError(toError),
  );
}

function runEchoExchange(config: InjectedConfig) {
  return Effect.gen(function* () {
    const inbound = yield* Deferred.make<InboundCapture>();
    const metadata: ChatMetadataCapture[] = [];
    const adapter = yield* acquireAdapter(inbound, metadata);
    const peer = yield* acquirePeer(config);

    const created = yield* peer
      .callDefinition(agentConversationCreate, {
        participants: [config.channelAgentId],
      })
      .pipe(Effect.mapError(toError));
    const conversationId = created.conversation.id;
    const chatJid = `${JID_PREFIX}${conversationId}`;

    const echoFiber = yield* Effect.fork(
      takeChannelReply(peer, config, conversationId),
    );
    yield* peer
      .callDefinition(messagesSend, {
        conversationId,
        parts: [{ type: TEXT_TYPE, text: PING }],
      })
      .pipe(Effect.mapError(toError));

    const delivered = yield* Deferred.await(inbound).pipe(
      Effect.timeoutFail({
        duration: REPLY_TIMEOUT,
        onTimeout: () => new Error("timed out waiting for the host inbound"),
      }),
    );
    expect(delivered.jid).toBe(chatJid);
    expect(contentText(delivered.msg)).toBe(PING);
    expect(senderIdOf(delivered.msg)).toBe(
      `${MOLTZAP_CHANNEL_NAME}:${config.peerAgentId}`,
    );

    // Metadata precedes the inbound dispatch, so it is already recorded by
    // the time the inbound deferred resolves.
    expect(metadata.some((entry) => entry.jid === chatJid)).toBe(true);
    expect(adapter.isConnected()).toBe(true);

    const echo = yield* Fiber.join(echoFiber);
    expect(messageText(echo)).toBe(`${ECHO_PREFIX}${PING}`);
  }).pipe(Effect.scoped);
}

describe("nanoclaw echo integration", () => {
  it("round-trips a peer message through the production adapter", () => {
    const config = injectedConfig();
    return Effect.scoped(
      Effect.gen(function* () {
        // The daemon binds exactly the port its slot records, so the port is
        // reserved here and written into the slot before the adapter starts.
        const mcpPort = yield* reserveTestMcpPort;
        return yield* withTestServiceConfig(
          {
            profileName: CHANNEL_PROFILE_NAME,
            agentName: CHANNEL_PROFILE_NAME,
            agentId: config.channelAgentId,
            agentKey: config.channelApiKey,
            serverUrl: config.baseUrl,
            mcpPort,
          },
          runEchoExchange(config),
        );
      }),
    );
  });
});
