import { Effect, Queue, Stream } from "effect";
import type {
  HarnessClientService,
  HarnessTurn,
} from "@moltzap/client/harness-client";
import type {
  CrossConvMessage,
  EnrichedConversationMeta,
} from "@moltzap/client/channel-base";
import {
  testAgentId,
  testConversationId,
  testMessageId,
} from "@moltzap/client/test-utils";

import { MoltZapAdapter, type HarnessClientAcquisition } from "./moltzap.js";
import type {
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from "./adapter.js";

/** Stable self identity shared by adapter projection fixtures. */
export const AGENT_SELF = "agent-self";
/** Stable peer identity shared by adapter projection fixtures. */
export const AGENT_ALICE = "agent-alice";
/** Display name paired with the shared peer identity. */
export const ALICE_NAME = "Alice";
/** Registration and sender namespace expected from the adapter. */
export const MOLTZAP_CHANNEL_NAME = "moltzap";
/** Default message identity for turns that do not test identity changes. */
export const MSG_ABC = "msg-abc";
/** Default turn body for tests that do not inspect custom content. */
export const HI_NANOCLAW = "hi nanoclaw";
/** Stable timestamp that keeps projected turn assertions deterministic. */
export const MESSAGE_CREATED_AT = "2026-04-10T13:00:00.000Z";
/** Call-order marker emitted by the recorded inbound callback. */
export const ON_INBOUND = "onInbound";
/** Call-order marker emitted by the recorded metadata callback. */
export const ON_METADATA = "onMetadata";

const JID_PREFIX = "mz:";
const OUTBOUND_KIND_CHAT = "chat";
const DEFAULT_HARNESS_ROUTE = "default-harness-route";
const DM_META: EnrichedConversationMeta = { type: "dm", participants: [] };

/** Expected NanoClaw content projection for structural assertions. */
export interface InboundContent {
  readonly text: string;
  readonly sender: string;
  readonly senderId: string;
}

interface ReceivedMessage {
  readonly jid: string;
  readonly threadId: string | null;
  readonly msg: InboundMessage;
}

interface MetadataRecord {
  readonly jid: string;
  readonly name?: string;
  readonly isGroup?: boolean;
}

/** Channel setup fake that records adapter callbacks and their order. */
export interface RecordedChannelSetup extends ChannelSetup {
  readonly received: ReceivedMessage[];
  readonly metadata: MetadataRecord[];
  readonly callOrder: string[];
}

/** Outbound reply captured with the bound client route that handled it. */
export interface HarnessClientReply {
  readonly route: string;
  readonly payload: string;
}

/** Counts how often the adapter opens and closes its client acquisition. */
export interface AcquisitionCounts {
  acquired: number;
  released: number;
}

/** State exposed by the shared adapter test harness. */
export interface Harness {
  readonly adapter: MoltZapAdapter;
  readonly config: RecordedChannelSetup;
  readonly counts: AcquisitionCounts;
  readonly replies: HarnessClientReply[];
  readonly turns: Queue.Queue<HarnessTurn>;
  readonly signal: Queue.Queue<string>;
}

/** Overrides used to construct one projected harness turn. */
export interface TurnOptions {
  readonly conversationId: string;
  readonly messageId?: string;
  readonly route?: string;
  readonly text?: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly isFromMe?: boolean;
  readonly conversationMeta?: EnrichedConversationMeta;
  readonly crossConversationMessages?: readonly CrossConvMessage[];
}

interface HarnessOptions {
  readonly evalMode?: boolean;
  readonly replies?: HarnessClientReply[];
  readonly turns?: Stream.Stream<HarnessTurn, Error>;
  readonly config?: RecordedChannelSetup;
  readonly acquire?: (
    client: HarnessClientService,
    counts: AcquisitionCounts,
  ) => HarnessClientAcquisition;
}

/**
 * Creates callbacks that record metadata and inbound delivery observations.
 * @param signal Queue notified after an inbound callback is recorded.
 * @param waitForInbound Optional callback barrier used by concurrency tests.
 * @returns A channel setup together with its mutable observation buffers.
 */
export function createRecordedSetup(
  signal: Queue.Queue<string>,
  waitForInbound?: (jid: string) => Effect.Effect<undefined>,
): RecordedChannelSetup {
  const received: ReceivedMessage[] = [];
  const metadata: MetadataRecord[] = [];
  const callOrder: string[] = [];
  return {
    onInbound: (jid, threadId, msg) => {
      received.push({ jid, threadId, msg });
      callOrder.push(ON_INBOUND);
      Queue.unsafeOffer(signal, jid);
      const wait = waitForInbound?.(jid);
      return wait === undefined ? undefined : Effect.runPromise(wait);
    },
    onMetadata: (jid, name, isGroup) => {
      metadata.push({ jid, name, isGroup });
      callOrder.push(ON_METADATA);
    },
    received,
    metadata,
    callOrder,
  };
}

function turnSender(options: TurnOptions): HarnessTurn["sender"] {
  return {
    id: testAgentId(options.senderId ?? AGENT_ALICE),
    name: options.senderName ?? ALICE_NAME,
  };
}

// The daemon projects context blocks before a turn reaches the adapter, so a
// fixture turn carries them the way `projectHarnessTurn` does.
function turnContextBlocks(options: TurnOptions): HarnessTurn["contextBlocks"] {
  return {
    ...(options.conversationMeta?.type === "group"
      ? { groupMetadata: options.conversationMeta }
      : {}),
    ...(options.crossConversationMessages === undefined
      ? {}
      : { crossConversationMessages: [...options.crossConversationMessages] }),
  };
}

/**
 * Creates one daemon-shaped turn with a reply route the test can inspect.
 * @param replies Buffer receiving replies made through the turn.
 * @param options Identity, content, and context overrides for the turn.
 * @returns A complete harness turn suitable for the adapter stream.
 */
export function makeHarnessTurn(
  replies: HarnessClientReply[],
  options: TurnOptions,
): HarnessTurn {
  const route = options.route ?? DEFAULT_HARNESS_ROUTE;
  return {
    id: testMessageId(options.messageId ?? MSG_ABC),
    conversationId: testConversationId(options.conversationId),
    sender: turnSender(options),
    text: options.text ?? HI_NANOCLAW,
    isFromMe: options.isFromMe ?? false,
    createdAt: MESSAGE_CREATED_AT,
    conversationMeta: options.conversationMeta ?? DM_META,
    contextBlocks: turnContextBlocks(options),
    reply: (payload) =>
      Effect.sync(() => {
        replies.push({ route, payload });
      }),
  };
}

/**
 * Builds an adapter over a counted client acquisition.
 * @param options Eval mode plus optional replies, turns, setup, and acquisition.
 * @returns The adapter with the fixtures its behavior is asserted against.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const turns = Effect.runSync(Queue.unbounded<HarnessTurn>());
  const signal = Effect.runSync(Queue.unbounded<string>());
  const replies = options.replies ?? [];
  const counts: AcquisitionCounts = { acquired: 0, released: 0 };
  const client: HarnessClientService = {
    agentId: testAgentId(AGENT_SELF),
    startConversation: () =>
      Effect.dieMessage("startConversation is not used by these tests"),
    turns: options.turns ?? Stream.fromQueue(turns),
  };
  const adapter = MoltZapAdapter.fromHarnessAcquisition(
    (options.acquire ?? countedAcquisition)(client, counts),
    options.evalMode ?? false,
  );
  return {
    adapter,
    config: options.config ?? createRecordedSetup(signal),
    counts,
    replies,
    turns,
    signal,
  };
}

/**
 * Wraps a client in an acquisition whose ownership transitions are observable.
 * @param client Client yielded to the adapter-owned scope.
 * @param counts Mutable acquisition and release counters.
 * @returns A scoped acquisition suitable for `MoltZapAdapter`.
 */
export function countedAcquisition(
  client: HarnessClientService,
  counts: AcquisitionCounts,
): HarnessClientAcquisition {
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The adapter under test owns the enclosing scope; that is the contract these counts assert.
  return Effect.acquireRelease(
    Effect.sync(() => {
      counts.acquired += 1;
      return client;
    }),
    () =>
      Effect.sync(() => {
        counts.released += 1;
      }),
  );
}

/**
 * Projects a conversation id into the channel's platform-id namespace.
 * @param conversationId Conversation fixture label.
 * @returns The branded conversation encoded as a MoltZap jid.
 */
export function asJid(conversationId: string): string {
  return `${JID_PREFIX}${testConversationId(conversationId)}`;
}

/**
 * Projects an agent label into the sender id exposed to NanoClaw.
 * @param label Agent fixture label.
 * @returns A channel-qualified sender id.
 */
export function senderIdFor(label: string): string {
  return `${MOLTZAP_CHANNEL_NAME}:${testAgentId(label)}`;
}

function makeOutbound(text: string): OutboundMessage {
  return { kind: OUTBOUND_KIND_CHAT, content: { text } };
}

/**
 * Narrows recorded content to the projection established by this fixture.
 * @param msg Recorded inbound message.
 * @returns The content shape produced by the adapter.
 */
export function inboundContent(msg: InboundMessage): InboundContent {
  return /* Safe because the test fixture establishes this asserted shape. */ msg.content as InboundContent;
}

/**
 * Reads the projected text from the first recorded inbound callback.
 * @param harness Harness containing callback observations.
 * @returns The first projected message body.
 */
export function firstReceivedContent(harness: Harness): string {
  return inboundContent(
    /* Safe because the test fixture establishes this asserted shape. */ harness
      .config.received[0]!.msg,
  ).text;
}

/**
 * Keeps NanoClaw's promise callback boundary inside Effect-driven tests.
 * @param evaluate Promise-producing adapter operation.
 * @returns The operation with rejection represented in the Effect error channel.
 */
export function runPromise<A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => cause,
  });
}

/**
 * Runs adapter setup against the harness's recorded callbacks.
 * @param harness Adapter and callback fixture.
 * @returns The setup operation with promise rejection in the error channel.
 */
export function setup(harness: Harness): Effect.Effect<void, unknown> {
  return runPromise(() => harness.adapter.setup(harness.config));
}

/**
 * Runs teardown for the adapter owned by a harness.
 * @param harness Adapter and acquisition fixture.
 * @returns The teardown operation with promise rejection in the error channel.
 */
export function teardown(harness: Harness): Effect.Effect<void, unknown> {
  return runPromise(() => harness.adapter.teardown());
}

/**
 * Delivers a text reply through NanoClaw's promise callback boundary.
 * @param adapter Adapter under test.
 * @param jid Platform id that owns the reply route.
 * @param text Reply text.
 * @returns The delivery operation with promise rejection in the error channel.
 */
export function deliver(
  adapter: MoltZapAdapter,
  jid: string,
  text: string,
): Effect.Effect<void, unknown> {
  return runPromise(() => adapter.deliver(jid, null, makeOutbound(text)));
}

/**
 * Offers one turn and resolves once the adapter dispatches it inbound.
 * @param harness Adapter and fixtures under test.
 * @param options Shape of the turn the client emits.
 * @returns The jid the adapter dispatches that turn under.
 */
export function offerTurn(
  harness: Harness,
  options: TurnOptions,
): Effect.Effect<string, unknown> {
  return Queue.offer(
    harness.turns,
    makeHarnessTurn(harness.replies, options),
  ).pipe(Effect.zipRight(Queue.take(harness.signal)));
}

/**
 * Guarantees adapter teardown around an Effect-driven assertion body.
 * @param harness Adapter and acquisition fixture to close.
 * @param effect Assertion body that uses the harness.
 * @returns The assertion body with teardown attached on every exit.
 */
export function withTeardown<A>(
  harness: Harness,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return effect.pipe(Effect.ensuring(teardown(harness).pipe(Effect.ignore)));
}
