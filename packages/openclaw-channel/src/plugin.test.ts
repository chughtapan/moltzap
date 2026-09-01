/** @file MoltZap channel behavior against OpenClaw's public inbound runner. */

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type {
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { live as it } from "@effect/vitest";
import {
  type HarnessEndpoint,
  type InboundDelivery,
  InboundMessage,
  ListenError,
  type SendInput,
} from "@moltzap/client";
import { Data, Effect, Encoding, Fiber, Schema, Stream } from "effect";
import { join } from "node:path";
import {
  buildChannelInboundEventContext,
  type ChannelInboundEventRunnerParams,
  type ChannelInboundTurnPlan,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
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
  readonly message: InboundDelivery["message"];
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
    "runs shared inbound turns in the main session and acknowledges after completion",
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

function upstreamRunnerAndAcknowledgment() {
  const events: string[] = [];
  const direct = directMessage();
  const group = groupMessage();
  const fake = makeInboundEndpoint([direct, group], events);
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
    expectRoutedTurn(requireTurnPlan(plans, 0), direct.message.address);
    expectRoutedTurn(requireTurnPlan(plans, 1), group.message.address);
    expectDirectProjection(requireDispatchCall(calls, 0), direct.message);
    expectGroupProjection(requireDispatchCall(calls, 1), group.message);
    expect(plans.every((plan) => plan.replyOptions === undefined)).toBe(true);
    expect(events).toEqual([
      `record:${direct.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${direct.message.postId}`,
      `send:${direct.message.address}:host final`,
      `ack:${direct.message.postId}`,
      `record:${group.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${group.message.postId}`,
      `send:${group.message.address}:host final`,
      `ack:${group.message.postId}`,
    ]);
    expect(fake.sends).toEqual([
      {
        to: direct.message.address,
        content: [{ type: "text", text: "host final" }],
      },
      {
        to: group.message.address,
        content: [{ type: "text", text: "host final" }],
      },
    ]);
    yield* proactiveSendFailsWhenDisconnected(plugin, fake, 2);
  });
}

function privateModeUsesHostResolvedPeerSession() {
  const events: string[] = [];
  const message = groupMessage();
  const fake = makeInboundEndpoint([message], events);
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
  const sessionKey = sessionKeyFor(message.message.address);

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

    expectRoutedTurn(
      requireTurnPlan(plans, 0),
      message.message.address,
      sessionKey,
    );
    expectGroupProjection(
      requireDispatchCall(calls, 0),
      message.message,
      sessionKey,
    );
    expect(events).toContain(`record:${message.message.postId}:${sessionKey}`);
  });
}

function failedHostTurnPreservesDelivery() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint([message], events);
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
      `record:${message.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch-failed:${message.message.postId}`,
    ]);
    expect(fake.sends).toEqual([]);
  });
}

function replayRemainsHostOwned() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint([message, message], events);
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
    expect(fake.sends).toHaveLength(2);
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

function emptyReplyRemainsInvisible() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint([message], events);
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
      `record:${message.message.postId}:${MAIN_SESSION_KEY}`,
      `dispatch:${message.message.postId}`,
      `ack:${message.message.postId}`,
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

function directMessage(): InboundDelivery {
  return delivery(
    Schema.decodeUnknownSync(InboundMessage)({
      kind: "direct",
      postId: postId(1),
      address: "agent:alice",
      sender: "agent:alice",
      content: [
        { type: "text", text: "hello" },
        { type: "data", value: { count: 2 } },
      ],
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
  return makeEndpoint(Stream.fromIterable(acknowledged), events);
}

function makeListeningEndpoint(): FakeHarnessEndpoint {
  return makeEndpoint(Stream.never, []);
}

function makeEndpoint(
  messages: HarnessEndpoint["messages"],
  events: string[],
): FakeHarnessEndpoint {
  const sends: SendInput[] = [];
  return {
    sends,
    endpoint: {
      send: (input) =>
        Effect.sync(() => {
          sends.push(input);
          const text = input.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          events.push(`send:${input.to}:${text}`);
        }),
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
  expect(plan).not.toHaveProperty("agentId");
  expect(plan).not.toHaveProperty("routeSessionKey");
  expect(plan).not.toHaveProperty("storePath");
  expect(plan).not.toHaveProperty("recordInboundSession");
  expect(plan).not.toHaveProperty("dispatchReplyWithBufferedBlockDispatcher");
}

function expectDirectProjection(
  call: DispatchObservation,
  message: InboundDelivery["message"],
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
    SenderName: "alice",
    SessionKey: expectedSessionKey,
  });
  expect(call.ctx.GroupMembers).toBeUndefined();
}

function expectGroupProjection(
  call: DispatchObservation,
  message: InboundDelivery["message"],
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
