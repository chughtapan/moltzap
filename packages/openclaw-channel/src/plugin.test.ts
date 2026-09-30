/** @file MoltZap channel behavior against OpenClaw's public inbound runner. */

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  ChannelMessageActionContext,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type {
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { live as it } from "@effect/vitest";
import {
  CollectiveError,
  CollectiveResponse,
  type HarnessEndpoint,
  type InboundDelivery,
  InboundItem,
  InboundMessage,
  ListenError,
  type SendInput,
  type SendResult,
} from "@moltzap/client";
import { Data, Effect, Encoding, Fiber, Schema, Stream } from "effect";
import { join } from "node:path";
import {
  buildChannelInboundEventContext,
  type ChannelInboundEventRunnerParams,
  type ChannelInboundTurnPlan,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { Type } from "typebox";
import { describe, expect, vi, it as vitestIt } from "vitest";

import manifest from "../openclaw.plugin.json" with { type: "json" };
import { openClawTestStateDirectory } from "../vitest.setup.js";
import {
  createMoltzapChannelPlugin,
  makeMoltZapChannelConfigJsonSchema,
} from "./plugin.js";

const ACCOUNT_ID = "primary";
const MAIN_SESSION_KEY = "agent:primary:main";
const TEST_SESSION_STORE_PATH = join(
  openClawTestStateDirectory,
  "sessions.json",
);

type MoltZapPlugin = ReturnType<typeof createMoltzapChannelPlugin>;
type OpenClawInboundRunInput = ChannelInboundEventRunnerParams<{
  readonly turn: object;
}>;
type ResolvedInboundTurn = Awaited<
  ReturnType<OpenClawInboundRunInput["adapter"]["resolveTurn"]>
>;

interface ObservedAccountRuntime extends ChannelRuntimeSurface {
  readonly inbound: {
    readonly buildContext: PluginRuntime["channel"]["inbound"]["buildContext"];
    readonly run: (
      input: OpenClawInboundRunInput,
    ) => ReturnType<typeof runChannelInboundEvent>;
  };
  readonly routing: Pick<
    PluginRuntime["channel"]["routing"],
    "resolveAgentRoute"
  >;
}

interface DispatchObservation {
  readonly ctx: ChannelInboundTurnPlan["ctxPayload"];
  readonly replyOptions: ChannelInboundTurnPlan["replyOptions"];
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
  readonly failDispatch?: boolean;
  readonly plans?: ChannelInboundTurnPlan[];
  readonly replyText?: string;
}

class OpenClawTestError extends Data.TaggedError("OpenClawTestError")<{
  readonly operation: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

describe("OpenClaw HarnessEndpoint adapter", () => {
  it(
    "runs shared inbound turns in the main session, withholds final text, and acknowledges after completion",
    upstreamRunnerAndAcknowledgment,
  );
  it(
    "runs private inbound turns in the host-resolved peer session",
    privateModeUsesHostResolvedPeerSession,
  );
  it(
    "leaves a Client delivery pending when the host turn fails",
    failedHostTurnPreservesDelivery,
  );
  it(
    "forwards a replay to the host without adapter-owned deduplication",
    replayRemainsHostOwned,
  );
  it(
    "returns distinct receipt IDs without changing the Client send contract",
    proactiveSendUsesLocalReceiptIdentity,
  );
  it(
    "acknowledges a host-suppressed empty reply without sending",
    emptyReplyRemainsInvisible,
  );
  it(
    "fails startup before endpoint acquisition when the account runtime is absent",
    missingAccountRuntimeFailsStartup,
  );
  it(
    "disconnects the account when the endpoint stream fails",
    inboundStreamFailureDisconnects,
  );
  it(
    "rejects a target outside the explicit address grammar",
    rejectsInvalidTarget,
  );
  vitestIt(
    "keeps the OpenClaw manifest schema in sync",
    manifestMatchesRuntimeSchema,
  );
});

describe("OpenClaw message tool send action", () => {
  it(
    "sends a message tool send with its collective operation and returns ok",
    messageToolSendCarriesCollective,
  );
  it(
    "sends a message tool send without a collective operation as a multicast",
    messageToolSendDefaultsToMulticast,
  );
  it(
    "rejects a message tool send whose collective operation is unknown",
    messageToolSendRejectsUnknownOperation,
  );
  it(
    "rejects a message tool send to an invalid address",
    messageToolSendRejectsInvalidAddress,
  );
  vitestIt(
    "offers the send action with an optional collective parameter",
    messageToolOffersOptionalCollective,
  );
  it(
    "sends a gather and returns its operation id in the tool result",
    messageToolSendReturnsGatherId,
  );
  it(
    "sends a collectiveResponse without the target or message text",
    messageToolSendsCollectiveResponse,
  );
  it(
    "fails the tool with the Client error naming each unreachable member",
    messageToolSendSurfacesCollectiveError,
  );
  vitestIt(
    "offers an optional collectiveResponse parameter and the gather operation",
    messageToolOffersCollectiveResponse,
  );
});

describe("OpenClaw collective item turns", () => {
  it(
    "renders a collective request as a direct turn from the requester",
    rendersCollectiveRequest,
  );
  it(
    "renders a gather result as one group turn attributed to the collective",
    rendersCollectiveResult,
  );
  it(
    "renders an operation failure as a turn attributed to the collective",
    rendersOperationFailure,
  );
});

function upstreamRunnerAndAcknowledgment() {
  const events: string[] = [];
  const direct = directMessage();
  const group = groupMessage();
  const fake = makeInboundEndpoint(
    [multicast(direct), multicast(group)],
    events,
  );
  const calls: DispatchObservation[] = [];
  const plans: ChannelInboundTurnPlan[] = [];
  const routePeers: RuntimeFixtureParams["routePeers"] = [];
  const runtime = makeObservedRuntime({ events, calls, plans, routePeers });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, runtime),
    );

    expect(routePeers).toEqual([
      { kind: "direct", id: "alice" },
      { kind: "group", id: "alice,bob,carol" },
    ]);
    expect(calls).toHaveLength(2);
    expectRoutedTurn(requireTurnPlan(plans, 0), direct.address);
    expectRoutedTurn(requireTurnPlan(plans, 1), group.address);
    expectDirectProjection(requireDispatchCall(calls, 0), direct);
    expectGroupProjection(requireDispatchCall(calls, 1), group);
    expect(plans.every((plan) => plan.replyOptions === undefined)).toBe(true);
    expect(events).toEqual([
      `record:${direct.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${direct.postId}`,
      `ack:${direct.postId}`,
      `record:${group.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${group.postId}`,
      `ack:${group.postId}`,
    ]);
    expect(fake.sends).toEqual([]);
    yield* proactiveSendFailsWhenDisconnected(plugin, fake, 0);
  });
}

function privateModeUsesHostResolvedPeerSession() {
  const events: string[] = [];
  const message = groupMessage();
  const fake = makeInboundEndpoint([multicast(message)], events);
  const calls: DispatchObservation[] = [];
  const plans: ChannelInboundTurnPlan[] = [];
  const runtime = makeObservedRuntime({
    events,
    calls,
    plans,
    routePeers: [],
  });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const sessionKey = sessionKeyFor(message.address);

  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(
        new AbortController().signal,
        runtime,
        undefined,
        "private",
      ),
    );

    expectRoutedTurn(requireTurnPlan(plans, 0), message.address, sessionKey);
    expectGroupProjection(requireDispatchCall(calls, 0), message, sessionKey);
    expect(events).toContain(`record:${message.postId}:${sessionKey}`);
  });
}

function failedHostTurnPreservesDelivery() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint([multicast(message)], events);
  const runtime = makeObservedRuntime({
    events,
    calls: [],
    routePeers: [],
    failDispatch: true,
  });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    const failure = yield* Effect.flip(
      startAccount(
        plugin,
        gatewayContext(new AbortController().signal, runtime),
      ),
    );

    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(events).toEqual([
      `record:${message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch-failed:${message.postId}`,
    ]);
    expect(fake.sends).toEqual([]);
  });
}

function replayRemainsHostOwned() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint(
    [multicast(message), multicast(message)],
    events,
  );
  const calls: DispatchObservation[] = [];
  const runtime = makeObservedRuntime({ events, calls, routePeers: [] });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, runtime),
    );

    expect(calls).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("ack:"))).toHaveLength(2);
    expect(fake.sends).toEqual([]);
  });
}

function proactiveSendUsesLocalReceiptIdentity() {
  const fake = makeListeningEndpoint();
  const runtime = makeObservedRuntime({
    events: [],
    calls: [],
    routePeers: [],
  });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();
  const setStatus = vi.fn();

  return Effect.gen(function* () {
    const fiber = yield* startAccount(
      plugin,
      gatewayContext(controller.signal, runtime, setStatus),
    ).pipe(Effect.fork);
    yield* waitForConnected(setStatus);
    const { direct, group } = yield* executeProactiveSends(plugin);

    expect(direct.messageId).toEqual(expect.any(String));
    expect(group.messageId).toEqual(expect.any(String));
    expect(direct.messageId).not.toHaveLength(0);
    expect(group.messageId).not.toHaveLength(0);
    expect(direct.messageId).not.toBe(group.messageId);
    expect(fake.sends).toEqual([
      { to: "agent:nova", text: "hello nova" },
      { to: "group:alice,bob,carol", text: "hello group" },
    ]);
    expect(plugin.messaging?.targetResolver?.looksLikeId?.("agent:nova")).toBe(
      true,
    );
    expect(plugin.messaging?.targetResolver?.looksLikeId?.("nova")).toBe(false);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
    yield* proactiveSendFailsWhenDisconnected(plugin, fake, 2);
  });
}

function proactiveSendFailsWhenDisconnected(
  plugin: MoltZapPlugin,
  fake: FakeHarnessEndpoint,
  expectedSendCount: number,
) {
  return Effect.gen(function* () {
    const failure = yield* Effect.tryPromise({
      try: () =>
        requireSendText(plugin)({
          cfg: makeConfig(),
          accountId: ACCOUNT_ID,
          to: "agent:nova",
          text: "while disconnected",
        }),
      catch: (cause) => testError("sendAfterAbort", cause),
    }).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(fake.sends).toHaveLength(expectedSendCount);
  });
}

function executeProactiveSends(plugin: MoltZapPlugin) {
  const sendText = requireSendText(plugin);
  return Effect.gen(function* () {
    const direct = yield* Effect.tryPromise({
      try: () =>
        sendText({
          cfg: makeConfig(),
          accountId: ACCOUNT_ID,
          to: "agent:nova",
          text: "hello nova",
        }),
      catch: (cause) => testError("sendText", cause),
    });
    const group = yield* Effect.tryPromise({
      try: () =>
        sendText({
          cfg: makeConfig(),
          accountId: ACCOUNT_ID,
          to: "group:alice,bob,carol",
          text: "hello group",
        }),
      catch: (cause) => testError("sendGroupText", cause),
    });
    return { direct, group };
  });
}

function rejectsInvalidTarget() {
  const fake = makeListeningEndpoint();
  const runtime = makeObservedRuntime({
    events: [],
    calls: [],
    routePeers: [],
  });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();
  const setStatus = vi.fn();

  return Effect.gen(function* () {
    const fiber = yield* startAccount(
      plugin,
      gatewayContext(controller.signal, runtime, setStatus),
    ).pipe(Effect.fork);
    yield* waitForConnected(setStatus);
    const failure = yield* Effect.tryPromise({
      try: () =>
        requireSendText(plugin)({
          cfg: makeConfig(),
          accountId: ACCOUNT_ID,
          to: "nova",
          text: "hello",
        }),
      catch: (cause) => testError("invalidTarget", cause),
    }).pipe(Effect.flip);

    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(fake.sends).toEqual([]);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolSendCarriesCollective() {
  const fake = makeListeningEndpoint();
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    const result = yield* handleSendAction(plugin, {
      to: "group:alice,bob,carol",
      message: "hello group",
      collective: { op: "multicast" },
    });

    expect(fake.sends).toEqual([
      {
        to: "group:alice,bob,carol",
        text: "hello group",
        collective: { op: "multicast" },
      },
    ]);
    expect(result.details).toEqual({ ok: true, to: "group:alice,bob,carol" });

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolSendDefaultsToMulticast() {
  const fake = makeListeningEndpoint();
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    yield* handleSendAction(plugin, { to: "agent:nova", message: "hello" });

    expect(fake.sends).toEqual([{ to: "agent:nova", text: "hello" }]);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolSendRejectsUnknownOperation() {
  const fake = makeListeningEndpoint();
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    const failure = yield* handleSendAction(plugin, {
      to: "agent:nova",
      message: "hello",
      collective: { op: "broadcast" },
    }).pipe(Effect.flip);

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The closed failure reason is what the model reads back from the tool.
    expect(failure.detail).toContain("invalid-operation");
    expect(fake.sends).toEqual([]);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolSendRejectsInvalidAddress() {
  const fake = makeListeningEndpoint();
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    const failure = yield* handleSendAction(plugin, {
      to: "nova",
      message: "hello",
    }).pipe(Effect.flip);

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The closed failure reason is what the model reads back from the tool.
    expect(failure.detail).toContain("invalid-address");
    expect(fake.sends).toEqual([]);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolOffersOptionalCollective() {
  const discovery = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: makeConfig(),
  });
  const schema = discovery?.schema;
  if (schema === undefined || schema === null || Array.isArray(schema)) {
    throw new Error("expected one message tool schema contribution");
  }

  expect(discovery?.actions).toEqual(["send"]);
  expect(schema.properties.collective).toMatchObject({
    anyOf: [
      { properties: { op: { type: "string", enum: ["multicast"] } } },
      {},
    ],
  });
  expect(Type.Object(schema.properties).required ?? []).toEqual([]);
}

const COLLECTIVE_ID = `col_${Encoding.encodeBase64Url(new Uint8Array(32).fill(5))}`;
const SLOT_SCHEMA = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};

function messageToolSendReturnsGatherId() {
  const fake = makeEndpoint(
    Stream.never,
    [],
    Effect.succeed({ operationId: collectiveId() }),
  );
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();
  const collective = {
    op: "gather",
    deadline: 300,
    requestedSchema: SLOT_SCHEMA,
  };

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    const result = yield* handleSendAction(plugin, {
      to: "group:alice,bob,carol",
      message: "Which day?",
      collective,
    });

    expect(fake.sends).toEqual([
      { to: "group:alice,bob,carol", text: "Which day?", collective },
    ]);
    expect(result.details).toEqual({
      ok: true,
      to: "group:alice,bob,carol",
      operationId: COLLECTIVE_ID,
    });

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolSendsCollectiveResponse() {
  const fake = makeListeningEndpoint();
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();
  const collectiveResponse = { id: COLLECTIVE_ID, action: "decline" };

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    yield* handleSendAction(plugin, {
      to: "agent:nova",
      message: "declining",
      collectiveResponse,
    });

    expect(fake.sends).toEqual([{ collectiveResponse }]);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolSendSurfacesCollectiveError() {
  const refusal = new CollectiveError({
    id: collectiveId(),
    failure: {
      kind: "members-unreachable",
      members: [
        {
          member: Schema.decodeUnknownSync(InboundMessage)({
            kind: "direct",
            postId: postId(3),
            address: "agent:carol",
            sender: "agent:carol",
            content: [{ type: "text", text: "unused" }],
          }).sender,
          reason: "unknown-agent",
        },
      ],
    },
  });
  const fake = makeEndpoint(Stream.never, [], Effect.fail(refusal));
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const controller = new AbortController();

  return Effect.gen(function* () {
    const fiber = yield* connectAccount(plugin, controller.signal);
    const failure = yield* handleSendAction(plugin, {
      to: "group:alice,bob,carol",
      message: "Which day?",
      collective: { op: "gather", deadline: 60, requestedSchema: SLOT_SCHEMA },
    }).pipe(Effect.flip);

    expect(failure.detail).toContain(refusal.message);

    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function messageToolOffersCollectiveResponse() {
  const discovery = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: makeConfig(),
  });
  const schema = discovery?.schema;
  if (schema === undefined || schema === null || Array.isArray(schema)) {
    throw new Error("expected one message tool schema contribution");
  }

  expect(schema.properties.collectiveResponse).toMatchObject({
    anyOf: [
      { properties: { action: { enum: ["accept"] } } },
      { properties: { action: { enum: ["decline", "cancel"] } } },
    ],
  });
  expect(schema.properties.collective).toMatchObject({
    anyOf: [{}, { properties: { op: { enum: ["gather"] } } }],
  });
}

function rendersCollectiveRequest() {
  const item = Schema.decodeUnknownSync(InboundItem)({
    kind: "collectiveRequest",
    id: COLLECTIVE_ID,
    postId: postId(4),
    from: "agent:alice",
    question: "Which day?",
    requestedSchema: SLOT_SCHEMA,
    deadlineAt: Date.UTC(2026, 8, 30, 12),
  });

  return Effect.gen(function* () {
    const call = yield* runItemTurn(item);

    expect(call.ctx).toMatchObject({
      Body: [
        `MoltZap collective request ${COLLECTIVE_ID} from agent:alice, open until 2026-09-30T12:00:00.000Z.`,
        "Question: Which day?",
        `Answer form (requestedSchema): ${JSON.stringify(SLOT_SCHEMA)}`,
        `Answer once with the message tool's send action and collectiveResponse {"id":"${COLLECTIVE_ID}","action":"accept","content":{...}} matching the form, or {"id":"${COLLECTIVE_ID}","action":"decline"}.`,
      ].join("\n"),
      ChatType: "direct",
      From: "agent:alice",
      MessageSid: postId(4),
    });
  });
}

function rendersCollectiveResult() {
  const item = Schema.decodeUnknownSync(InboundItem)({
    kind: "collectiveResult",
    id: COLLECTIVE_ID,
    to: "group:alice,bob,carol",
    question: "Which day?",
    outcomes: [
      {
        member: "agent:bob",
        outcome: { kind: "answered", content: { slot: "mon" } },
      },
      { member: "agent:carol", outcome: { kind: "no-answer" } },
    ],
  });

  return Effect.gen(function* () {
    const call = yield* runItemTurn(item);

    expect(call.ctx).toMatchObject({
      Body: [
        `MoltZap collective result ${COLLECTIVE_ID} for the question sent to group:alice,bob,carol: Which day?`,
        '- agent:bob: answered {"slot":"mon"}',
        "- agent:carol: no answer by the deadline",
      ].join("\n"),
      ChatId: "group:alice,bob,carol",
      ChatType: "group",
      SenderName: "MoltZap collective",
      MessageSid: `${COLLECTIVE_ID}:result`,
    });
  });
}

function rendersOperationFailure() {
  const item = Schema.decodeUnknownSync(InboundItem)({
    kind: "operationFailed",
    id: COLLECTIVE_ID,
    to: "agent:alice",
    error: "collective failed: this request's deadline has passed",
  });

  return Effect.gen(function* () {
    const call = yield* runItemTurn(item);

    expect(call.ctx).toMatchObject({
      Body: "MoltZap operation failed: collective failed: this request's deadline has passed",
      ChatId: "agent:alice",
      SenderName: "MoltZap collective",
      MessageSid: `${COLLECTIVE_ID}:failed`,
    });
  });
}

/** Run one item through the account's inbound path and return its dispatch. */
function runItemTurn(item: InboundItem) {
  const events: string[] = [];
  const calls: DispatchObservation[] = [];
  const fake = makeInboundEndpoint([item], events);
  const runtime = makeObservedRuntime({ events, calls, routePeers: [] });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  return startAccount(
    plugin,
    gatewayContext(new AbortController().signal, runtime),
  ).pipe(Effect.map(() => requireDispatchCall(calls, 0)));
}

function collectiveId() {
  return Schema.decodeUnknownSync(CollectiveResponse)({
    id: COLLECTIVE_ID,
    action: "decline",
  }).id;
}

function connectAccount(plugin: MoltZapPlugin, abortSignal: AbortSignal) {
  const runtime = makeObservedRuntime({
    events: [],
    calls: [],
    routePeers: [],
  });
  const setStatus = vi.fn();
  return Effect.gen(function* () {
    const fiber = yield* startAccount(
      plugin,
      gatewayContext(abortSignal, runtime, setStatus),
    ).pipe(Effect.fork);
    yield* waitForConnected(setStatus);
    return fiber;
  });
}

function handleSendAction(
  plugin: MoltZapPlugin,
  params: ChannelMessageActionContext["params"],
) {
  const handleAction = plugin.actions?.handleAction;
  if (handleAction === undefined) {
    return Effect.fail(testError("handleAction", "missing action handler"));
  }
  return Effect.tryPromise({
    try: () =>
      handleAction({
        channel: "moltzap",
        action: "send",
        cfg: makeConfig(),
        accountId: ACCOUNT_ID,
        params,
      }),
    catch: (cause) => testError("handleAction", cause),
  });
}

function emptyReplyRemainsInvisible() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint([multicast(message)], events);
  const runtime = makeObservedRuntime({
    events,
    calls: [],
    routePeers: [],
    replyText: "",
  });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });

  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, runtime),
    );

    expect(events).toEqual([
      `record:${message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${message.postId}`,
      `ack:${message.postId}`,
    ]);
    expect(fake.sends).toEqual([]);
  });
}

function missingAccountRuntimeFailsStartup() {
  const endpointFactory = vi.fn(() => makeListeningEndpoint().endpoint);
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: endpointFactory,
  });

  return Effect.gen(function* () {
    const failure = yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal),
    ).pipe(Effect.flip);

    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(endpointFactory).not.toHaveBeenCalled();
  });
}

function inboundStreamFailureDisconnects() {
  const streamFailure = new ListenError({ reason: "transport-failed" });
  const fake = makeEndpoint(Stream.fail(streamFailure), []);
  const runtime = makeObservedRuntime({
    events: [],
    calls: [],
    routePeers: [],
  });
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => fake.endpoint,
  });
  const setStatus = vi.fn();

  return Effect.gen(function* () {
    const failure = yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, runtime, setStatus),
    ).pipe(Effect.flip);

    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ connected: false, running: false }),
    );
    yield* proactiveSendFailsWhenDisconnected(plugin, fake, 0);
  });
}

function manifestMatchesRuntimeSchema() {
  expect(createMoltzapChannelPlugin().agentPrompt).toBeUndefined();
  const { $schema, ...generated } = makeMoltZapChannelConfigJsonSchema();
  expect($schema).toBeDefined();
  if (!("required" in generated)) {
    throw new Error("expected an object schema");
  }
  const { required, ...embedded } = generated;
  expect(required).toHaveLength(0);
  expect(manifest.channelConfigs.moltzap.schema).toEqual(embedded);
}

function makeObservedRuntime(
  params: RuntimeFixtureParams,
): ObservedAccountRuntime {
  return {
    runtimeContexts: {
      register: () => ({ dispose: () => undefined }),
      get: () => undefined,
      watch: () => () => undefined,
    },
    inbound: {
      buildContext: buildChannelInboundEventContext,
      run: observedOpenClawInboundRunner(params),
    },
    routing: makeRoutingRuntime(params),
  };
}

function observedOpenClawInboundRunner(
  params: RuntimeFixtureParams,
): ObservedAccountRuntime["inbound"]["run"] {
  return (input) =>
    runChannelInboundEvent({
      ...input,
      adapter: {
        ...input.adapter,
        resolveTurn: (normalized, eventClass, preflight) =>
          Effect.runPromise(
            Effect.tryPromise({
              try: () =>
                Promise.resolve(
                  input.adapter.resolveTurn(normalized, eventClass, preflight),
                ),
              catch: (cause) => testError("resolveTurn", cause),
            }).pipe(Effect.map((resolved) => observedTurn(params, resolved))),
          ),
      },
      log: (event) => {
        if (event.stage === "record" && event.event === "done") {
          params.events.push(
            `record:${event.messageId ?? "missing"}:${event.sessionKey ?? "missing"}`,
          );
        }
      },
    });
}

function observedTurn(
  params: RuntimeFixtureParams,
  resolved: ResolvedInboundTurn,
): ChannelInboundTurnPlan {
  const turn = requireRoutedTurnPlan(resolved);
  params.plans?.push(turn);
  return {
    ...turn,
    dispatchReplyFromConfig: observedReplyDispatch(params),
  };
}

function requireRoutedTurnPlan(
  turn: ResolvedInboundTurn,
): ChannelInboundTurnPlan {
  if (
    !("route" in turn) ||
    !("delivery" in turn) ||
    !("deliver" in turn.delivery) ||
    typeof turn.delivery.deliver !== "function"
  ) {
    throw new Error("expected a core-managed routed inbound turn");
  }
  return turn;
}

function makeRoutingRuntime(
  params: RuntimeFixtureParams,
): ObservedAccountRuntime["routing"] {
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
            : sessionKeyForPeer(input.peer.kind, input.peer.id),
        mainSessionKey: MAIN_SESSION_KEY,
        lastRoutePolicy: "session",
        matchedBy: "default",
      };
    },
  };
}

function observedReplyDispatch(
  params: RuntimeFixtureParams,
): NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]> {
  return ({ ctx, dispatcher, replyOptions }) => {
    const messageId = ctx.MessageSid ?? "missing";
    params.calls.push({ ctx, replyOptions });
    if (params.failDispatch === true) {
      params.events.push(`dispatch-failed:${messageId}`);
      return Promise.reject(testError("dispatch", "OpenClaw turn failed"));
    }
    const text = params.replyText ?? "host final";
    params.events.push(`dispatch:${messageId}`);
    const queuedFinal = dispatcher.sendFinalReply({ text });
    return Promise.resolve({
      queuedFinal,
      counts: { tool: 0, block: 0, final: queuedFinal ? 1 : 0 },
    });
  };
}

function directMessage(): InboundMessage {
  return Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: postId(1),
    address: "agent:alice",
    sender: "agent:alice",
    content: [
      { type: "text", text: "hello" },
      { type: "data", value: { count: 2 } },
    ],
  });
}

function groupMessage(): InboundMessage {
  return Schema.decodeUnknownSync(InboundMessage)({
    kind: "group",
    postId: postId(2),
    address: "group:alice,bob,carol",
    sender: "agent:bob",
    members: ["agent:alice", "agent:bob", "agent:carol"],
    content: [{ type: "text", text: "group message" }],
  });
}

function multicast(message: InboundMessage): InboundItem {
  return { kind: "multicast", message };
}

/** The turn id OpenClaw sees for an item, which the fake acknowledgment logs. */
function itemTurnId(item: InboundItem): string {
  switch (item.kind) {
    case "multicast":
      return item.message.postId;
    case "collectiveRequest":
      return item.postId;
    case "collectiveResult":
      return `${item.id}:result`;
    case "operationFailed":
      return `${item.id}:failed`;
    default:
      return item satisfies never;
  }
}

function postId(fill: number): string {
  return `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(fill))}`;
}

function makeInboundEndpoint(
  items: readonly InboundItem[],
  events: string[],
): FakeHarnessEndpoint {
  const deliveries = items.map(
    (item): InboundDelivery => ({
      item,
      acknowledge: Effect.sync(() => {
        events.push(`ack:${itemTurnId(item)}`);
      }),
    }),
  );
  return makeEndpoint(Stream.fromIterable(deliveries), events);
}

function makeListeningEndpoint(): FakeHarnessEndpoint {
  return makeEndpoint(Stream.never, []);
}

/** The fake endpoint's default send outcome: a multicast's empty result. */
const SEND_SUCCEEDS: Effect.Effect<SendResult, CollectiveError> =
  Effect.succeed({});

function makeEndpoint(
  messages: HarnessEndpoint["messages"],
  events: string[],
  result: Effect.Effect<SendResult, CollectiveError> = SEND_SUCCEEDS,
): FakeHarnessEndpoint {
  const sends: SendInput[] = [];
  return {
    sends,
    endpoint: {
      send: (input) =>
        Effect.sync(() => {
          sends.push(input);
          events.push(`send:${JSON.stringify(input)}`);
        }).pipe(Effect.zipRight(result)),
      messages,
    },
  };
}

function gatewayContext(
  abortSignal: AbortSignal,
  channelRuntime?: ChannelRuntimeSurface,
  setStatus?: ReturnType<typeof vi.fn>,
  mode: "shared" | "private" = "shared",
): ChannelGatewayContext<{
  readonly id: string;
  readonly enabled?: boolean;
  readonly mode: "shared" | "private";
}> {
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
    ...(channelRuntime === undefined ? {} : { channelRuntime }),
    getStatus: () => snapshot,
    setStatus: (next) => {
      snapshot = next;
      statusSink(next);
    },
  };
}

function makeConfig(mode: "shared" | "private" = "shared"): OpenClawConfig {
  return {
    channels: {
      moltzap: {
        accounts: [{ id: ACCOUNT_ID, mode }],
      },
    },
    session: { store: TEST_SESSION_STORE_PATH },
  };
}

function startAccount(
  plugin: MoltZapPlugin,
  ctx: ChannelGatewayContext<{
    readonly id: string;
    readonly enabled?: boolean;
    readonly mode?: "shared" | "private";
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

function requireSendText(plugin: MoltZapPlugin) {
  const sendText = plugin.message?.send?.text;
  if (sendText === undefined) {
    throw new Error("missing OpenClaw text sender");
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

function testError(operation: string, cause: unknown): OpenClawTestError {
  return new OpenClawTestError({ operation, detail: String(cause) });
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

function requireTurnPlan(
  plans: readonly ChannelInboundTurnPlan[],
  index: number,
): ChannelInboundTurnPlan {
  const plan = plans[index];
  if (plan === undefined) {
    throw new Error(`missing routed turn plan ${String(index)}`);
  }
  return plan;
}

function expectRoutedTurn(
  plan: ChannelInboundTurnPlan,
  address: string,
  expectedSessionKey: string = MAIN_SESSION_KEY,
): void {
  expect(plan.route).toEqual({
    agentId: "primary",
    sessionKey: expectedSessionKey,
  });
  expect(plan.record?.updateLastRoute).toEqual({
    sessionKey: expectedSessionKey,
    channel: "moltzap",
    to: address,
    accountId: ACCOUNT_ID,
  });
}

function expectDirectProjection(
  call: DispatchObservation,
  message: InboundMessage,
  expectedSessionKey: string = MAIN_SESSION_KEY,
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
    SenderIsBot: true,
    SenderName: "alice",
    SessionKey: expectedSessionKey,
  });
  expect(call.ctx.GroupMembers).toBeUndefined();
}

function expectGroupProjection(
  call: DispatchObservation,
  message: InboundMessage,
  expectedSessionKey: string = MAIN_SESSION_KEY,
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
    SenderIsBot: true,
    SenderName: "bob",
    SessionKey: expectedSessionKey,
  });
}

function sessionKeyFor(address: string): string {
  return address.startsWith("group:")
    ? sessionKeyForPeer("group", address.slice("group:".length))
    : sessionKeyForPeer("direct", address.slice("agent:".length));
}

function sessionKeyForPeer(kind: string, id: string): string {
  return `agent:primary:moltzap:${kind}:${id}`;
}
