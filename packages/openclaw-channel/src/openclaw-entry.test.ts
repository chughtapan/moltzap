/** @file Native OpenClaw session and durable-message integration tests. */

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCompletedRecord,
  ChannelIngressQueueEnqueueResult,
  ChannelIngressQueueFailedRecord,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import { live as it } from "@effect/vitest";
import {
  type HarnessEndpoint,
  type InboundDelivery,
  InboundMessage,
  type SendInput,
} from "@moltzap/client";
import { Data, Effect, Encoding, Fiber, Schema, Stream } from "effect";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, vi, it as vitestIt } from "vitest";

import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  createMoltzapChannelPlugin,
  makeMoltZapChannelConfigJsonSchema,
} from "./openclaw-entry.js";

const ACCOUNT_ID = "primary";
const DIRECT_QUEUE_ID = "openclaw.queue:41";
const GROUP_QUEUE_ID = "openclaw.queue:42";
const MAIN_SESSION_KEY = "agent:primary:main";
const SOURCE_REPLY_DELIVERY_MODE = "message_tool_only";
const TURN_TOOLS_ALLOW = ["*"];
const TEST_SESSION_STORE_PATH = ".moltzap-openclaw-test-sessions.json";
const NATIVE_JOURNAL_FAILED = "native-journal-failed";

type NativeRuntime = Parameters<typeof createMoltzapChannelPlugin>[0];
type MoltZapPlugin = ReturnType<typeof createMoltzapChannelPlugin>;
type NativeDispatch =
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
type NativeDispatchInput = Parameters<NativeDispatch>[0];
type MoltZapReplyOptions = NonNullable<NativeDispatchInput["replyOptions"]>;

interface TestInboundPayload {
  readonly message: InboundDelivery["message"];
}

type TestInboundQueue = ChannelIngressQueue<
  TestInboundPayload,
  never,
  TestInboundPayload
>;
type TestPendingRecord = ChannelIngressQueueRecord<TestInboundPayload, never>;
type TestCompletedRecord =
  ChannelIngressQueueCompletedRecord<TestInboundPayload>;
type TestCompletionBehavior = "complete" | "refuse";

interface TestInboundQueueState {
  readonly queue: TestInboundQueue;
  readonly pendingIds: () => readonly string[];
  readonly completedIds: () => readonly string[];
}

class OpenClawTestError extends Data.TaggedError("OpenClawTestError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

interface DispatchObservation {
  readonly ctx: NativeDispatchInput["ctx"];
  readonly replyOptions?: MoltZapReplyOptions;
}

interface FakeHarnessEndpoint {
  readonly endpoint: HarnessEndpoint;
  readonly sends: readonly SendInput[];
}

interface RuntimeFixtureParams {
  readonly events: string[];
  readonly calls: DispatchObservation[];
  readonly routePeers: Array<{
    readonly kind: string;
    readonly id: string;
  } | null>;
  readonly ingress?: TestInboundQueueState;
  readonly failRecord?: boolean;
}

describe("OpenClaw HarnessEndpoint adapter", () => {
  it(
    "uses one main session and source-bound native output in shared mode",
    sharedModeUsesOneNativeSession,
  );
  it(
    "uses address sessions and source-bound output in private mode",
    privateModeUsesAddressSessions,
  );
  it(
    "keeps OpenClaw message identity out of the Client send contract",
    nativeSendKeepsHostMessageIdentityLocal,
  );
  it(
    "treats a host send without queue identity as one invocation",
    nativeSendWithoutQueueIdentityUsesInvocationIdentity,
  );
  it(
    "replays a journaled delivery after interruption before acknowledgment",
    interruptedDeliveryReplaysWithoutSecondDispatch,
  );
  it(
    "rejects a changed payload under a completed PostId",
    changedPayloadFailsClosed,
  );
  it(
    "releases a pending delivery when native dispatch fails",
    failedNativeDispatchReleasesDelivery,
  );
  it(
    "fails closed when native ingress completion is refused",
    refusedNativeCompletionFailsClosed,
  );
  vitestIt(
    "keeps the OpenClaw manifest schema in sync",
    manifestMatchesRuntimeSchema,
  );
});

function sharedModeUsesOneNativeSession() {
  const events: string[] = [];
  const direct = directMessage();
  const group = groupMessage();
  const fake = makeInboundEndpoint([direct, group], events);
  const calls: DispatchObservation[] = [];
  const routePeers: Array<{
    readonly kind: string;
    readonly id: string;
  } | null> = [];
  const runtime = makeRuntime({ events, calls, routePeers });
  const plugin = createMoltzapChannelPlugin(runtime, {
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, "shared"),
    );

    expect(routePeers).toEqual([null, null]);
    expect(calls).toHaveLength(2);
    expectDirectProjection(requireDispatchCall(calls, 0), direct.message);
    expectGroupProjection(requireDispatchCall(calls, 1), group.message);
    expectSourceBoundReplyOptions(calls);
    expect(events).toEqual([
      `journal:accepted:${direct.message.postId}`,
      `ack:${direct.message.postId}`,
      `record:${direct.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${direct.message.postId}`,
      `journal:complete:${direct.message.postId}`,
      `journal:accepted:${group.message.postId}`,
      `ack:${group.message.postId}`,
      `record:${group.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${group.message.postId}`,
      `journal:complete:${group.message.postId}`,
    ]);
    expect(fake.sends).toEqual([]);
    expect(plugin.agentPrompt).toBeUndefined();
  });
}

function privateModeUsesAddressSessions() {
  const events: string[] = [];
  const direct = directMessage();
  const group = groupMessage();
  const fake = makeInboundEndpoint([direct, group], events);
  const calls: DispatchObservation[] = [];
  const routePeers: Array<{
    readonly kind: string;
    readonly id: string;
  } | null> = [];
  const runtime = makeRuntime({ events, calls, routePeers });
  const plugin = createMoltzapChannelPlugin(runtime, {
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, "private"),
    );

    expect(routePeers).toEqual([
      { kind: "direct", id: direct.message.address },
      { kind: "group", id: group.message.address },
    ]);
    expect(calls.map((call) => call.ctx.SessionKey)).toEqual([
      sessionKeyFor(direct.message.address),
      sessionKeyFor(group.message.address),
    ]);
    expectSourceBoundReplyOptions(calls);
  });
}

function expectSourceBoundReplyOptions(calls: readonly DispatchObservation[]) {
  expect(
    calls.every(
      (call) =>
        call.replyOptions?.sourceReplyDeliveryMode ===
          SOURCE_REPLY_DELIVERY_MODE &&
        JSON.stringify(call.replyOptions.toolsAllow) ===
          JSON.stringify(TURN_TOOLS_ALLOW),
    ),
  ).toBe(true);
  for (const call of calls) {
    expect(call.replyOptions).not.toHaveProperty(
      "requireExplicitMessageTarget",
    );
  }
}

function nativeSendKeepsHostMessageIdentityLocal() {
  const fake = makeListeningEndpoint();
  const runtime = makeRuntime({ events: [], calls: [], routePeers: [] });
  const plugin = createMoltzapChannelPlugin(runtime, {
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();
  const setStatus = vi.fn();
  const running = startAccount(
    plugin,
    gatewayContext(controller.signal, "shared", setStatus),
  ).pipe(Effect.fork);

  return Effect.gen(function* () {
    const fiber = yield* running;
    yield* waitForConnected(setStatus);
    const { direct, group } = yield* executeNativeSends(plugin);

    expect(direct.messageId).toBe(DIRECT_QUEUE_ID);
    expect(group.messageId).toBe(GROUP_QUEUE_ID);
    expect(fake.sends).toEqual([
      {
        to: "agent:nova",
        content: [{ type: "text", text: "hello nova" }],
      },
      {
        to: "group:alice,bob,carol",
        content: [{ type: "text", text: "hello group" }],
      },
    ]);
    expect(plugin.message?.durableFinal).toBeUndefined();
    expect(plugin.messaging?.targetResolver?.looksLikeId?.("agent:nova")).toBe(
      true,
    );
    expect(plugin.messaging?.targetResolver?.looksLikeId?.("nova")).toBe(false);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function executeNativeSends(plugin: MoltZapPlugin) {
  const sendText = requireSendText(plugin);
  return Effect.gen(function* () {
    const direct = yield* Effect.tryPromise({
      try: () =>
        sendText({
          cfg: makeConfig("shared"),
          accountId: ACCOUNT_ID,
          to: "agent:nova",
          text: "hello nova",
          deliveryQueueId: DIRECT_QUEUE_ID,
        }),
      catch: (cause) => testError("sendText", cause),
    });
    const group = yield* Effect.tryPromise({
      try: () =>
        sendText({
          cfg: makeConfig("shared"),
          accountId: ACCOUNT_ID,
          to: "group:alice,bob,carol",
          text: "hello group",
          deliveryQueueId: GROUP_QUEUE_ID,
        }),
      catch: (cause) => testError("sendGroupText", cause),
    });
    return { direct, group };
  });
}

function nativeSendWithoutQueueIdentityUsesInvocationIdentity() {
  const fake = makeListeningEndpoint();
  const runtime = makeRuntime({ events: [], calls: [], routePeers: [] });
  const plugin = createMoltzapChannelPlugin(runtime, {
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();
  const setStatus = vi.fn();

  return Effect.gen(function* () {
    const fiber = yield* startAccount(
      plugin,
      gatewayContext(controller.signal, "shared", setStatus),
    ).pipe(Effect.fork);
    yield* waitForConnected(setStatus);
    const result = yield* Effect.tryPromise({
      try: () =>
        requireSendText(plugin)({
          cfg: makeConfig("shared"),
          accountId: ACCOUNT_ID,
          to: "agent:nova",
          text: "hello nova",
        }),
      catch: (cause) => testError("sendTextWithoutQueueIdentity", cause),
    });
    const [send] = fake.sends;
    expect(send).toMatchObject({
      to: "agent:nova",
      content: [{ type: "text", text: "hello nova" }],
    });
    expect(result.messageId).toEqual(expect.any(String));
    expect(result.messageId).not.toHaveLength(0);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function interruptedDeliveryReplaysWithoutSecondDispatch() {
  const events: string[] = [];
  const original = directMessage();
  const ingress = makeTestInboundQueue(events);
  const calls: DispatchObservation[] = [];
  const firstController = new AbortController();
  const interrupted = makeRawInboundEndpoint([
    { message: original.message, acknowledge: Effect.never },
  ]);
  const firstPlugin = createMoltzapChannelPlugin(
    makeRuntime({ events, calls, routePeers: [], ingress }),
    { harnessEndpointForAccount: () => interrupted.endpoint },
  );

  return Effect.gen(function* () {
    const firstRun = yield* startAccount(
      firstPlugin,
      gatewayContext(firstController.signal, "shared"),
    ).pipe(Effect.fork);
    yield* waitForPending(ingress, original.message.postId);
    firstController.abort();
    yield* Effect.timeout(Fiber.join(firstRun), "1 second");

    const replayed = makeInboundEndpoint([original], events);
    const restartedPlugin = createMoltzapChannelPlugin(
      makeRuntime({ events, calls, routePeers: [], ingress }),
      { harnessEndpointForAccount: () => replayed.endpoint },
    );
    yield* startAccount(
      restartedPlugin,
      gatewayContext(new AbortController().signal, "shared"),
    );

    expect(calls).toHaveLength(1);
    expect(ingress.pendingIds()).toEqual([]);
    expect(ingress.completedIds()).toEqual([original.message.postId]);
    expect(events).toEqual([
      `journal:accepted:${original.message.postId}`,
      `record:${original.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${original.message.postId}`,
      `journal:complete:${original.message.postId}`,
      `journal:duplicate-completed:${original.message.postId}`,
      `ack:${original.message.postId}`,
    ]);
  });
}

function changedPayloadFailsClosed() {
  const events: string[] = [];
  const original = directMessage();
  const changed = directMessageWithText("changed payload");
  const ingress = makeTestInboundQueue(events);
  const calls: DispatchObservation[] = [];
  const firstPlugin = createMoltzapChannelPlugin(
    makeRuntime({ events, calls, routePeers: [], ingress }),
    {
      harnessEndpointForAccount: () =>
        makeInboundEndpoint([original], events).endpoint,
    },
  );

  return Effect.gen(function* () {
    yield* startAccount(
      firstPlugin,
      gatewayContext(new AbortController().signal, "shared"),
    );

    const changedPlugin = createMoltzapChannelPlugin(
      makeRuntime({ events, calls, routePeers: [], ingress }),
      {
        harnessEndpointForAccount: () =>
          makeInboundEndpoint([changed], events).endpoint,
      },
    );
    const failure = yield* Effect.flip(
      startAccount(
        changedPlugin,
        gatewayContext(new AbortController().signal, "shared"),
      ),
    );

    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([
      `journal:accepted:${original.message.postId}`,
      `ack:${original.message.postId}`,
      `record:${original.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${original.message.postId}`,
      `journal:complete:${original.message.postId}`,
      `journal:duplicate-completed:${original.message.postId}`,
    ]);
  });
}

function failedNativeDispatchReleasesDelivery() {
  const events: string[] = [];
  const message = directMessage();
  const ingress = makeTestInboundQueue(events);
  const fake = makeInboundEndpoint([message], events);
  const runtime = makeRuntime({
    events,
    calls: [],
    routePeers: [],
    ingress,
    failRecord: true,
  });
  const plugin = createMoltzapChannelPlugin(runtime, {
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    const failure = yield* Effect.flip(
      startAccount(
        plugin,
        gatewayContext(new AbortController().signal, "shared"),
      ),
    );
    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(ingress.pendingIds()).toEqual([message.message.postId]);
    expect(events).toEqual([
      `journal:accepted:${message.message.postId}`,
      `ack:${message.message.postId}`,
      `record:${message.message.postId}:failed`,
      `journal:release:${message.message.postId}`,
    ]);
  });
}

function refusedNativeCompletionFailsClosed() {
  const events: string[] = [];
  const message = directMessage();
  const ingress = makeTestInboundQueue(events, "refuse");
  const calls: DispatchObservation[] = [];
  const plugin = createMoltzapChannelPlugin(
    makeRuntime({ events, calls, routePeers: [], ingress }),
    {
      harnessEndpointForAccount: () =>
        makeInboundEndpoint([message], events).endpoint,
    },
  );

  return Effect.gen(function* () {
    const failure = yield* Effect.tryPromise({
      try: () =>
        requireStartAccount(plugin)(
          gatewayContext(new AbortController().signal, "shared"),
        ),
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : testError("refusedNativeCompletion", cause),
    }).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(ACCOUNT_ID);
    expect(failure.message).toContain(NATIVE_JOURNAL_FAILED);

    expect(calls).toHaveLength(1);
    expect(ingress.pendingIds()).toEqual([message.message.postId]);
    expect(ingress.completedIds()).toEqual([]);
    expect(events).toEqual([
      `journal:accepted:${message.message.postId}`,
      `ack:${message.message.postId}`,
      `record:${message.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${message.message.postId}`,
      `journal:complete-refused:${message.message.postId}`,
    ]);
  });
}

function manifestMatchesRuntimeSchema() {
  const { $schema, ...generated } = makeMoltZapChannelConfigJsonSchema();
  expect($schema).toBeDefined();
  if (!("required" in generated)) {
    throw new Error("expected an object schema");
  }
  const { required, ...embedded } = generated;
  expect(required).toHaveLength(0);
  expect(manifest.channelConfigs.moltzap.schema).toEqual(embedded);
}

function makeRuntime(params: RuntimeFixtureParams): NativeRuntime {
  const ingress = params.ingress ?? makeTestInboundQueue(params.events);
  return {
    inbound: {
      buildContext: buildChannelInboundEventContext,
      run: runChannelInboundEvent,
    },
    routing: makeRoutingRuntime(params),
    session: {
      recordInboundSession: makeInboundSessionRecorder(params),
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: makeReplyDispatcher(params),
    },
    state: {
      openChannelIngressQueue: () => ingress.queue,
    },
  };
}

function makeRoutingRuntime(
  params: RuntimeFixtureParams,
): NativeRuntime["routing"] {
  return {
    resolveAgentRoute: (input) => {
      params.routePeers.push(input.peer ?? null);
      return {
        agentId: "primary",
        channel: "moltzap",
        accountId: input.accountId ?? ACCOUNT_ID,
        sessionKey:
          input.peer === undefined || input.peer === null
            ? MAIN_SESSION_KEY
            : sessionKeyFor(input.peer.id),
        mainSessionKey: MAIN_SESSION_KEY,
        lastRoutePolicy: "session",
        matchedBy: "default",
      };
    },
  };
}

function makeInboundSessionRecorder(params: RuntimeFixtureParams) {
  return (
    input: Parameters<NativeRuntime["session"]["recordInboundSession"]>[0],
  ) => {
    if (params.failRecord === true) {
      params.events.push(`record:${input.ctx.MessageSid ?? "missing"}:failed`);
      return Promise.reject(new Error("native record unavailable"));
    }
    params.events.push(
      `record:${input.ctx.MessageSid ?? "missing"}:${input.sessionKey}`,
    );
    return Promise.resolve();
  };
}

function makeReplyDispatcher(params: RuntimeFixtureParams): NativeDispatch {
  return (input) => {
    params.calls.push({
      ctx: input.ctx,
      replyOptions: input.replyOptions,
    });
    params.events.push(`dispatch:${input.ctx.MessageSid ?? "missing"}`);
    return Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          input.dispatcherOptions.deliver(
            { text: "private final" },
            { kind: "final" },
          ),
        catch: (cause) => testError("deliverFinal", cause),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toEqual({ visibleReplySent: false });
          }),
        ),
        Effect.as({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
          sourceReplyDeliveryMode: SOURCE_REPLY_DELIVERY_MODE,
        }),
      ),
    );
  };
}

function directMessage(): InboundDelivery {
  return directMessageWithContent([
    { type: "text", text: "hello" },
    { type: "data", value: { count: 2 } },
  ]);
}

function directMessageWithText(text: string): InboundDelivery {
  return directMessageWithContent([{ type: "text", text }]);
}

function directMessageWithContent(
  content: InboundDelivery["message"]["content"],
): InboundDelivery {
  return delivery(
    Schema.decodeUnknownSync(InboundMessage)({
      kind: "direct",
      postId: postId(1),
      address: "agent:alice",
      sender: "agent:alice",
      content,
    }),
  );
}

function groupMessage(): InboundDelivery {
  return delivery(
    Schema.decodeUnknownSync(InboundMessage)({
      kind: "group",
      postId: postId(2),
      address: "group:alice,bob,carol",
      sender: "agent:bob",
      members: ["agent:alice", "agent:bob", "agent:carol"],
      content: [{ type: "text", text: "group message" }],
    }),
  );
}

function delivery(message: InboundDelivery["message"]): InboundDelivery {
  return { message, acknowledge: Effect.void };
}

function postId(fill: number): string {
  return `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(fill))}`;
}

function makeInboundEndpoint(
  deliveries: readonly InboundDelivery[],
  events: string[],
): FakeHarnessEndpoint {
  const acknowledged = deliveries.map((item) => ({
    message: item.message,
    acknowledge: Effect.sync(() => {
      events.push(`ack:${item.message.postId}`);
    }),
  }));
  return makeRawInboundEndpoint(acknowledged);
}

function makeRawInboundEndpoint(
  deliveries: readonly InboundDelivery[],
): FakeHarnessEndpoint {
  const sends: SendInput[] = [];
  return {
    sends,
    endpoint: {
      send: (input) =>
        Effect.sync(() => {
          sends.push(input);
        }),
      messages: Stream.fromIterable(deliveries),
    },
  };
}

class TestNativeIngressQueue
  implements TestInboundQueue, TestInboundQueueState
{
  readonly queue: TestInboundQueue = this;
  private readonly events: string[];
  private readonly pending = new Map<string, TestPendingRecord>();
  private readonly completed = new Map<string, TestCompletedRecord>();
  private readonly completionBehavior: TestCompletionBehavior;
  private readonly failed = new Map<string, ChannelIngressQueueFailedRecord>();
  private currentTime = 1;

  constructor(events: string[], completionBehavior: TestCompletionBehavior) {
    this.events = events;
    this.completionBehavior = completionBehavior;
  }

  pendingIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  completedIds(): readonly string[] {
    return [...this.completed.keys()];
  }

  enqueue(
    id: string,
    payload: TestInboundPayload,
    options?: Parameters<TestInboundQueue["enqueue"]>[2],
  ) {
    const duplicate = this.duplicate(id);
    if (duplicate !== null) {
      return Promise.resolve(duplicate);
    }
    const receivedAt = options?.receivedAt ?? this.nextTime();
    const record: TestPendingRecord = {
      id,
      channelId: "openclaw-channel",
      accountId: ACCOUNT_ID,
      queueName: "default",
      payload,
      receivedAt,
      updatedAt: receivedAt,
      ...(options?.laneKey === undefined ? {} : { laneKey: options.laneKey }),
      attempts: 0,
    };
    this.pending.set(id, record);
    this.events.push(`journal:accepted:${id}`);
    return Promise.resolve({
      kind: "accepted" as const,
      duplicate: false as const,
      record,
    });
  }

  listPending(options?: Parameters<TestInboundQueue["listPending"]>[0]) {
    const records = [...this.pending.values()].sort((left, right) =>
      options?.orderBy === "id"
        ? left.id.localeCompare(right.id)
        : left.receivedAt - right.receivedAt || left.id.localeCompare(right.id),
    );
    return Promise.resolve(
      typeof options?.limit === "number"
        ? records.slice(0, options.limit)
        : records,
    );
  }

  listClaims() {
    return Promise.resolve([]);
  }

  claimNext() {
    return Promise.resolve(null);
  }

  claim() {
    return Promise.resolve(null);
  }

  refreshClaim() {
    return Promise.resolve(false);
  }

  complete(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: Parameters<TestInboundQueue["complete"]>[1],
  ) {
    const id = queueRecordId(idOrClaim);
    if (this.completionBehavior === "refuse") {
      this.events.push(`journal:complete-refused:${id}`);
      return Promise.resolve(false);
    }
    if (!this.pending.delete(id)) {
      return Promise.resolve(false);
    }
    const record: TestCompletedRecord = {
      id,
      channelId: "openclaw-channel",
      accountId: ACCOUNT_ID,
      queueName: "default",
      completedAt: options?.completedAt ?? this.nextTime(),
      ...(options?.metadata === undefined
        ? {}
        : { metadata: options.metadata }),
    };
    this.completed.set(id, record);
    this.events.push(`journal:complete:${id}`);
    return Promise.resolve(true);
  }

  release(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: Parameters<TestInboundQueue["release"]>[1],
  ) {
    const id = queueRecordId(idOrClaim);
    const record = this.pending.get(id);
    if (record === undefined) {
      return Promise.resolve(false);
    }
    const releasedAt = options?.releasedAt ?? this.nextTime();
    this.pending.set(id, {
      ...record,
      updatedAt: releasedAt,
      attempts: record.attempts + 1,
      lastAttemptAt: releasedAt,
      ...(options?.lastError === undefined
        ? {}
        : { lastError: options.lastError }),
    });
    this.events.push(`journal:release:${id}`);
    return Promise.resolve(true);
  }

  fail(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options: Parameters<TestInboundQueue["fail"]>[1],
  ) {
    const id = queueRecordId(idOrClaim);
    if (!this.pending.delete(id)) {
      return Promise.resolve(false);
    }
    this.failed.set(id, {
      id,
      channelId: "openclaw-channel",
      accountId: ACCOUNT_ID,
      queueName: "default",
      failedAt: options.failedAt ?? this.nextTime(),
      reason: options.reason,
      ...(options.message === undefined ? {} : { message: options.message }),
    });
    return Promise.resolve(true);
  }

  delete(idOrRecord: Parameters<TestInboundQueue["delete"]>[0]) {
    const id = queueRecordId(idOrRecord);
    const removedPending = this.pending.delete(id);
    const removedCompleted = this.completed.delete(id);
    const removedFailed = this.failed.delete(id);
    return Promise.resolve(removedPending || removedCompleted || removedFailed);
  }

  recoverStaleClaims() {
    return Promise.resolve(0);
  }

  prune() {
    return Promise.resolve(0);
  }

  private duplicate(
    id: string,
  ): ChannelIngressQueueEnqueueResult<
    TestInboundPayload,
    never,
    TestInboundPayload
  > | null {
    const completed = this.completed.get(id);
    if (completed !== undefined) {
      this.events.push(`journal:duplicate-completed:${id}`);
      return { kind: "completed", duplicate: true, record: completed };
    }
    const failed = this.failed.get(id);
    if (failed !== undefined) {
      this.events.push(`journal:duplicate-failed:${id}`);
      return { kind: "failed", duplicate: true, record: failed };
    }
    const pending = this.pending.get(id);
    if (pending !== undefined) {
      this.events.push(`journal:duplicate-pending:${id}`);
      return { kind: "pending", duplicate: true, record: pending };
    }
    return null;
  }

  private nextTime(): number {
    const now = this.currentTime;
    this.currentTime += 1;
    return now;
  }
}

function makeTestInboundQueue(
  events: string[],
  completionBehavior: TestCompletionBehavior = "complete",
): TestInboundQueueState {
  return new TestNativeIngressQueue(events, completionBehavior);
}

function queueRecordId(
  idOrRecord: string | TestPendingRecord | ChannelIngressQueueClaimRef,
): string {
  return typeof idOrRecord === "string" ? idOrRecord : idOrRecord.id;
}

function makeListeningEndpoint(): FakeHarnessEndpoint {
  const sends: SendInput[] = [];
  return {
    sends,
    endpoint: {
      send: (input) =>
        Effect.sync(() => {
          sends.push(input);
        }),
      messages: Stream.never,
    },
  };
}

function gatewayContext(
  abortSignal: AbortSignal,
  mode: "shared" | "private",
  setStatus?: ReturnType<typeof vi.fn>,
): ChannelGatewayContext<{ readonly id: string; readonly mode: typeof mode }> {
  let snapshot: ChannelAccountSnapshot = { accountId: ACCOUNT_ID };
  const statusSink = setStatus ?? vi.fn();
  return {
    cfg: makeConfig(mode),
    accountId: ACCOUNT_ID,
    account: { id: ACCOUNT_ID, mode },
    abortSignal,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    getStatus: () => snapshot,
    setStatus: (next) => {
      snapshot = next;
      statusSink(next);
    },
  };
}

function makeConfig(mode: "shared" | "private"): OpenClawConfig {
  return {
    channels: {
      moltzap: { accounts: [{ id: ACCOUNT_ID, mode }] },
    },
    session: { store: TEST_SESSION_STORE_PATH },
  };
}

function startAccount(
  plugin: ReturnType<typeof createMoltzapChannelPlugin>,
  ctx: ChannelGatewayContext<{
    readonly id: string;
    readonly mode: "shared" | "private";
  }>,
) {
  const start = plugin.gateway?.startAccount;
  if (start === undefined) {
    return Effect.fail(testError("startAccount", "missing gateway start"));
  }
  return Effect.tryPromise({
    try: () => start(ctx),
    catch: (cause) => testError("startAccount", cause),
  });
}

function requireStartAccount(plugin: MoltZapPlugin) {
  const start = plugin.gateway?.startAccount;
  if (start === undefined) {
    throw new Error("missing gateway start");
  }
  return start;
}

function requireSendText(
  plugin: ReturnType<typeof createMoltzapChannelPlugin>,
) {
  const sendText = plugin.message?.send?.text;
  if (sendText === undefined) {
    throw new Error("missing native text sender");
  }
  return sendText;
}

function waitForConnected(setStatus: ReturnType<typeof vi.fn>) {
  return Effect.tryPromise({
    try: () =>
      vi.waitFor(() => {
        expect(setStatus).toHaveBeenCalledWith(
          expect.objectContaining({ connected: true }),
        );
      }),
    catch: (cause) => testError("waitForConnected", cause),
  });
}

function waitForPending(ingress: TestInboundQueueState, postIdValue: string) {
  return Effect.tryPromise({
    try: () =>
      vi.waitFor(() => {
        expect(ingress.pendingIds()).toEqual([postIdValue]);
      }),
    catch: (cause) => testError("waitForPending", cause),
  });
}

function testError(operation: string, cause: unknown): OpenClawTestError {
  return new OpenClawTestError({ operation, detail: String(cause) });
}

function sessionKeyFor(address: string): string {
  return `agent:primary:moltzap:${address}`;
}

function requireDispatchCall(
  calls: readonly DispatchObservation[],
  index: number,
): DispatchObservation {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`missing dispatch call ${String(index)}`);
  }
  return call;
}

function expectDirectProjection(
  call: DispatchObservation,
  message: InboundDelivery["message"],
): void {
  expect(call.ctx).toMatchObject({
    Body: 'hello\n{"count":2}',
    BodyForAgent: 'hello\n{"count":2}',
    ChatId: "agent:alice",
    ChatType: "direct",
    From: "agent:alice",
    MessageSid: message.postId,
    OriginatingTo: "agent:alice",
    SenderId: "agent:alice",
    SenderName: "alice",
    SessionKey: MAIN_SESSION_KEY,
  });
  expect(call.ctx.GroupMembers).toBeUndefined();
}

function expectGroupProjection(
  call: DispatchObservation,
  message: InboundDelivery["message"],
): void {
  expect(call.ctx).toMatchObject({
    Body: "group message",
    ChatId: "group:alice,bob,carol",
    ChatType: "group",
    From: "agent:bob",
    GroupMembers: "agent:alice,agent:bob,agent:carol",
    GroupSubject: "group:alice,bob,carol",
    MessageSid: message.postId,
    OriginatingTo: "group:alice,bob,carol",
    SenderId: "agent:bob",
    SenderName: "bob",
    SessionKey: MAIN_SESSION_KEY,
  });
}
