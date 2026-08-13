/** @file Contract tests for NanoClaw's reduced HarnessClient adapter. */

import { live as it } from "@effect/vitest";
import {
  type Content,
  ConversationId,
  type HarnessClient,
  type HarnessTurn,
  type VerifiedAgentCard,
} from "@moltzap/client";
import { Deferred, Effect, Either, Queue, Schema, Stream } from "effect";
import { describe, expect, it as vitestIt } from "vitest";

import type {
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from "./adapter.js";
import {
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from "../db/messaging-groups.js";
import { getRegisteredChannelAdapter } from "./channel-registry.js";
import { makeMoltZapAdapter, MoltZapAdapter } from "./moltzap.js";

interface ReceivedMessage {
  readonly jid: string;
  readonly threadId: string | null;
  readonly message: InboundMessage;
}

interface MetadataRecord {
  readonly jid: string;
  readonly name?: string;
  readonly isGroup?: boolean;
}

interface RecordedSetup extends ChannelSetup {
  readonly received: ReceivedMessage[];
  readonly metadata: MetadataRecord[];
  readonly callOrder: string[];
  readonly receivedOne: Deferred.Deferred<undefined>;
}

interface FakeClient {
  readonly client: HarnessClient;
  readonly queue: Queue.Queue<HarnessTurn>;
  readonly replies: Content[];
}

interface Harness {
  readonly fake: FakeClient;
  readonly setup: RecordedSetup;
  readonly adapter: MoltZapAdapter;
}

const MOLTZAP_CHANNEL = "moltzap";
const EVAL_AGENT_GROUP_ID = "eval-agent";
const ON_METADATA = "onMetadata";
const ON_INBOUND = "onInbound";
const FIRST_CONVERSATION = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);
const SECOND_CONVERSATION = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000002",
);
const EVAL_CONVERSATION = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000003",
);
const LOCAL = fakeCard("agt_local", "local-agent");
const ALICE = fakeCard("agt_alice", "alice");
const BOB = fakeCard("agt_bob", "bob");
const HELLO_CONTENT = [{ type: "text", text: "hello" }] as const;
const OUTBOUND_KIND_CHAT = "chat";
const MENTIONS_NEVER = "never";

const jid = (conversationId: ConversationId): string => `mz:${conversationId}`;

function fakeCard(agentId: string, agentName: string): VerifiedAgentCard {
  const candidate: unknown = {
    agentId,
    agentName,
    principalId: `principal-${agentName}`,
    publicKey: { crv: "Ed25519", kty: "OKP", x: "fixture" },
    issuedAt: "2026-08-12T00:00:00Z",
  };
  if (!isFakeVerifiedAgentCard(candidate)) {
    throw new Error("invalid VerifiedAgentCard test fixture");
  }
  return candidate;
}

function isFakeVerifiedAgentCard(value: unknown): value is VerifiedAgentCard {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("agentId" in value) || typeof value.agentId !== "string") {
    return false;
  }
  return "agentName" in value && typeof value.agentName === "string";
}

function makeTurn(
  options: Partial<{
    readonly conversationId: ConversationId;
    readonly peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
    readonly author: VerifiedAgentCard;
    readonly content: Content;
  }> = {},
  replies: Content[] = [],
): HarnessTurn {
  return {
    conversationId: options.conversationId ?? FIRST_CONVERSATION,
    peers: options.peers ?? [ALICE],
    author: options.author ?? ALICE,
    content: options.content ?? HELLO_CONTENT,
    reply: (content) =>
      Effect.sync(() => {
        replies.push(content);
      }),
  };
}

const createFakeClient = (): Effect.Effect<FakeClient> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<HarnessTurn>();
    const replies: Content[] = [];
    const client: HarnessClient = {
      start: () => Effect.dieMessage("NanoClaw must not initiate START"),
      turns: Stream.fromQueue(queue),
    };
    return { client, queue, replies };
  });

const createRecordedSetup = (): Effect.Effect<RecordedSetup> =>
  Effect.gen(function* () {
    const receivedOne = yield* Deferred.make<undefined>();
    const received: ReceivedMessage[] = [];
    const metadata: MetadataRecord[] = [];
    const callOrder: string[] = [];
    return {
      onMetadata: (platformId, name, isGroup) => {
        metadata.push({ jid: platformId, name, isGroup });
        callOrder.push(ON_METADATA);
      },
      onInbound: (platformId, threadId, message) => {
        received.push({ jid: platformId, threadId, message });
        callOrder.push(ON_INBOUND);
        Effect.runSync(Deferred.succeed(receivedOne, undefined));
      },
      received,
      metadata,
      callOrder,
      receivedOne,
    };
  });

const createHarness = (evalMode = false): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const fake = yield* createFakeClient();
    const setup = yield* createRecordedSetup();
    return {
      fake,
      setup,
      adapter: MoltZapAdapter.fromClient(fake.client, evalMode),
    };
  });

const runPromise = <A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => cause,
  });

const setupAdapter = (harness: Harness): Effect.Effect<void, unknown> =>
  runPromise(() => harness.adapter.setup(harness.setup));

const teardownAdapter = (harness: Harness): Effect.Effect<void, unknown> =>
  runPromise(() => harness.adapter.teardown());

const deliver = (
  adapter: MoltZapAdapter,
  platformId: string,
  text: string,
): Effect.Effect<void, unknown> =>
  runPromise(() =>
    adapter.deliver(platformId, null, {
      kind: OUTBOUND_KIND_CHAT,
      content: { text },
    }),
  ).pipe(Effect.asVoid);

const expectFailure = (
  effect: Effect.Effect<void, unknown>,
  pattern: RegExp,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.either(effect);
    Either.match(result, {
      onLeft: (error) => {
        expect(String(error)).toMatch(pattern);
      },
      onRight: () => {
        expect.unreachable("expected the operation to fail");
      },
    });
  });

const waitsForOneTurn = (harness: Harness): Effect.Effect<void> =>
  Deferred.await(harness.setup.receivedOne);

function lifecycleTracksTheScopedTurnDrain() {
  return Effect.gen(function* () {
    const harness = yield* createHarness();
    expect(harness.adapter.isConnected()).toBe(false);
    yield* setupAdapter(harness);
    expect(harness.adapter.isConnected()).toBe(true);
    yield* teardownAdapter(harness);
    expect(harness.adapter.isConnected()).toBe(false);
  });
}

function projectsOneCurrentAction() {
  return Effect.gen(function* () {
    const harness = yield* createHarness();
    yield* setupAdapter(harness);
    yield* Queue.offer(
      harness.fake.queue,
      makeTurn(
        {
          content: [
            { type: "text", text: "hello" },
            { type: "data", value: { answer: 42 } },
          ],
        },
        harness.fake.replies,
      ),
    );
    yield* waitsForOneTurn(harness);
    assertCurrentActionProjection(harness);
    yield* teardownAdapter(harness);
  });
}

function assertCurrentActionProjection(harness: Harness): void {
  expect(harness.setup.callOrder).toEqual([ON_METADATA, ON_INBOUND]);
  expect(harness.setup.metadata).toEqual([
    { jid: jid(FIRST_CONVERSATION), name: "alice", isGroup: false },
  ]);
  const received = harness.setup.received[0];
  if (received === undefined) {
    throw new Error("expected projected current action");
  }
  expect(received.jid).toBe(jid(FIRST_CONVERSATION));
  expect(received.threadId).toBeNull();
  expect(received.message.kind).toBe(OUTBOUND_KIND_CHAT);
  expect(received.message.id).toMatch(/^mz-turn:/);
  expect(Date.parse(received.message.timestamp)).not.toBeNaN();
  expect(received.message.isGroup).toBe(false);
  expect(received.message.content).toEqual({
    text: 'hello\n{"answer":42}',
    sender: "alice",
    senderId: "moltzap:agt_alice",
  });
}

function projectsPeerMembershipForGroups() {
  return Effect.gen(function* () {
    const harness = yield* createHarness();
    yield* setupAdapter(harness);
    yield* Queue.offer(
      harness.fake.queue,
      makeTurn({ peers: [ALICE, BOB] }, harness.fake.replies),
    );
    yield* waitsForOneTurn(harness);
    expect(harness.setup.metadata).toEqual([
      { jid: jid(FIRST_CONVERSATION), name: "alice, bob", isGroup: true },
    ]);
    expect(harness.setup.received[0]?.message.isGroup).toBe(true);
    yield* teardownAdapter(harness);
  });
}

function dropsLocallyAuthoredTurns() {
  return Effect.gen(function* () {
    const harness = yield* createHarness();
    yield* setupAdapter(harness);
    yield* Queue.offer(
      harness.fake.queue,
      makeTurn({ author: LOCAL, peers: [ALICE] }, harness.fake.replies),
    );
    yield* Effect.sleep("10 millis");
    expect(harness.setup.received).toHaveLength(0);
    expect(harness.setup.metadata).toHaveLength(0);
    yield* teardownAdapter(harness);
  });
}

function replyExistsOnlyDuringItsAwaitedHostTurn() {
  return Effect.gen(function* () {
    const fake = yield* createFakeClient();
    const started = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const settled = yield* Deferred.make<undefined>();
    const setup: ChannelSetup = {
      onMetadata: () => {},
      onInbound: () => {
        Effect.runSync(Deferred.succeed(started, undefined));
        return Effect.runPromise(Deferred.await(release)).finally(() => {
          Effect.runSync(Deferred.succeed(settled, undefined));
        });
      },
    };
    const adapter = MoltZapAdapter.fromClient(fake.client);
    yield* runPromise(() => adapter.setup(setup));
    yield* Queue.offer(fake.queue, makeTurn({}, fake.replies));
    yield* Deferred.await(started);

    yield* deliver(adapter, jid(FIRST_CONVERSATION), "bound reply");
    expect(fake.replies).toEqual([[{ type: "text", text: "bound reply" }]]);

    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(settled);
    yield* Effect.sleep("1 millis");
    yield* expectFailure(
      deliver(adapter, jid(FIRST_CONVERSATION), "late reply"),
      /no active turn/,
    );
    yield* runPromise(() => adapter.teardown());
  });
}

function serializesTurnsWithoutFallingReplyForward() {
  return Effect.gen(function* () {
    const fake = yield* createFakeClient();
    const firstStarted = yield* Deferred.make<undefined>();
    const secondStarted = yield* Deferred.make<undefined>();
    const releaseFirst = yield* Deferred.make<undefined>();
    const received: string[] = [];
    const setup: ChannelSetup = {
      onMetadata: () => {},
      onInbound: (platformId) => {
        received.push(platformId);
        if (received.length === 1) {
          Effect.runSync(Deferred.succeed(firstStarted, undefined));
          return Effect.runPromise(Deferred.await(releaseFirst));
        }
        Effect.runSync(Deferred.succeed(secondStarted, undefined));
        return undefined;
      },
    };
    const adapter = MoltZapAdapter.fromClient(fake.client);
    yield* runPromise(() => adapter.setup(setup));
    yield* Queue.offer(fake.queue, makeTurn({}, fake.replies));
    yield* Queue.offer(
      fake.queue,
      makeTurn({ conversationId: SECOND_CONVERSATION }, fake.replies),
    );
    yield* Deferred.await(firstStarted);
    expect(received).toEqual([jid(FIRST_CONVERSATION)]);
    yield* deliver(adapter, jid(FIRST_CONVERSATION), "first");
    yield* expectFailure(
      deliver(adapter, jid(SECOND_CONVERSATION), "too early"),
      /no active turn/,
    );

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(secondStarted);
    expect(received).toEqual([
      jid(FIRST_CONVERSATION),
      jid(SECOND_CONVERSATION),
    ]);
    yield* deliver(adapter, jid(SECOND_CONVERSATION), "second");
    expect(fake.replies).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ]);
    yield* runPromise(() => adapter.teardown());
  });
}

function keepsHostShapeFailuresSeparate() {
  return Effect.gen(function* () {
    const harness = yield* createHarness();
    yield* setupAdapter(harness);
    yield* Queue.offer(harness.fake.queue, makeTurn({}, harness.fake.replies));
    yield* waitsForOneTurn(harness);
    yield* expectFailure(
      deliver(harness.adapter, "telegram:123", "wrong route"),
      /does not own jid/,
    );
    const invalidMessage: OutboundMessage = { kind: "file", content: {} };
    yield* expectFailure(
      runPromise(() =>
        harness.adapter.deliver(jid(FIRST_CONVERSATION), null, invalidMessage),
      ).pipe(Effect.asVoid),
      /require text content/,
    );
    yield* teardownAdapter(harness);
  });
}

function createsCompatibleEvalWiring() {
  return Effect.gen(function* () {
    const harness = yield* createHarness(true);
    yield* setupAdapter(harness);
    yield* Queue.offer(
      harness.fake.queue,
      makeTurn(
        {
          conversationId: EVAL_CONVERSATION,
          peers: [ALICE, BOB],
        },
        harness.fake.replies,
      ),
    );
    yield* waitsForOneTurn(harness);
    const group = getMessagingGroupByPlatform(
      MOLTZAP_CHANNEL,
      jid(EVAL_CONVERSATION),
    );
    if (group === undefined) {
      throw new Error("expected eval messaging group");
    }
    expect(group).toMatchObject({
      platform_id: jid(EVAL_CONVERSATION),
      name: "alice, bob",
      is_group: 1,
      unknown_sender_policy: "public",
    });
    const wiring = getMessagingGroupAgentByPair(group.id, EVAL_AGENT_GROUP_ID);
    expect(wiring).toMatchObject({
      engage_mode: "pattern",
      engage_pattern: ".",
      sender_scope: "all",
      ignored_message_policy: "drop",
      session_mode: "shared",
      priority: 0,
    });
    yield* teardownAdapter(harness);
  });
}

describe("MoltZapAdapter reduced Client boundary", () => {
  it(
    "tracks the scoped turn drain in its lifecycle",
    lifecycleTracksTheScopedTurnDrain,
  );
  it(
    "projects one current action without protocol or context payloads",
    projectsOneCurrentAction,
  );
  it(
    "projects fixed peers through NanoClaw group metadata",
    projectsPeerMembershipForGroups,
  );
  it("drops a locally authored turn", dropsLocallyAuthoredTurns);
  it(
    "keeps reply authority only for the awaited host turn",
    replyExistsOnlyDuringItsAwaitedHostTurn,
  );
  it(
    "serializes turns without falling reply authority forward",
    serializesTurnsWithoutFallingReplyForward,
  );
  it(
    "keeps NanoClaw shape errors separate from Client failures",
    keepsHostShapeFailuresSeparate,
  );
  it(
    "creates eval wiring from conversation and peer membership",
    createsCompatibleEvalWiring,
  );
});

describe("MoltZapAdapter registration", () => {
  vitestIt("registers defaults with mentions disabled", () => {
    expect(
      getRegisteredChannelAdapter(MOLTZAP_CHANNEL)?.defaults?.mentions,
    ).toBe(MENTIONS_NEVER);
  });
  vitestIt("does not create a production adapter without an MCP URL", () => {
    expect(
      makeMoltZapAdapter({ mcpEndpoint: null, evalMode: false }),
    ).toBeNull();
  });
  vitestIt("creates a production adapter from an MCP URL", () => {
    expect(
      makeMoltZapAdapter({
        mcpEndpoint: "http://127.0.0.1:4111/mcp",
        evalMode: false,
      }),
    ).toBeInstanceOf(MoltZapAdapter);
  });
});
