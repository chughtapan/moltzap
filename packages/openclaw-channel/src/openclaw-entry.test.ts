/** @file Stock OpenClaw callback integration tests. */

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk";
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
const MAIN_SESSION_KEY = "agent:primary:main";
const TEST_SESSION_STORE_PATH = ".moltzap-openclaw-test-sessions.json";

type NativeRuntime = Parameters<typeof createMoltzapChannelPlugin>[0];
type MoltZapPlugin = ReturnType<typeof createMoltzapChannelPlugin>;
type NativeDispatch =
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
type NativeDispatchInput = Parameters<NativeDispatch>[0];

interface DispatchObservation {
  readonly ctx: NativeDispatchInput["ctx"];
  readonly replyOptions: NativeDispatchInput["replyOptions"];
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
}

class OpenClawTestError extends Data.TaggedError("OpenClawTestError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

describe("OpenClaw HarnessEndpoint adapter", () => {
  it(
    "uses stock host routing and acknowledges after callback completion",
    stockHostRoutingAndAcknowledgment,
  );
  it(
    "leaves a Client delivery pending when the stock callback fails",
    failedHostCallbackPreservesDelivery,
  );
  it(
    "forwards a replay to the host without adapter-owned deduplication",
    replayRemainsHostOwned,
  );
  it(
    "returns distinct receipt IDs without changing the Client send contract",
    nativeSendUsesLocalReceiptIdentity,
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

function stockHostRoutingAndAcknowledgment() {
  const events: string[] = [];
  const direct = directMessage();
  const group = groupMessage();
  const fake = makeInboundEndpoint([direct, group], events);
  const calls: DispatchObservation[] = [];
  const routePeers: RuntimeFixtureParams["routePeers"] = [];
  const plugin = createMoltzapChannelPlugin(
    makeRuntime({ events, calls, routePeers }),
    { harnessEndpointForAccount: () => fake.endpoint },
  );

  return Effect.gen(function* () {
    yield* startAccount(plugin, gatewayContext(new AbortController().signal));

    expect(routePeers).toEqual([
      { kind: "direct", id: direct.message.address },
      { kind: "group", id: group.message.address },
    ]);
    expect(calls).toHaveLength(2);
    expectDirectProjection(requireDispatchCall(calls, 0), direct.message);
    expectGroupProjection(requireDispatchCall(calls, 1), group.message);
    expect(calls.every((call) => call.replyOptions === undefined)).toBe(true);
    expect(events).toEqual([
      `record:${direct.message.postId}:${sessionKeyFor(direct.message.address)}`,
      `dispatch:${direct.message.postId}`,
      `send:${direct.message.address}:host final`,
      `ack:${direct.message.postId}`,
      `record:${group.message.postId}:${sessionKeyFor(group.message.address)}`,
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
    expect(plugin.agentPrompt).toBeUndefined();
  });
}

function failedHostCallbackPreservesDelivery() {
  const events: string[] = [];
  const message = directMessage();
  const fake = makeInboundEndpoint([message], events);
  const plugin = createMoltzapChannelPlugin(
    makeRuntime({ events, calls: [], routePeers: [], failDispatch: true }),
    { harnessEndpointForAccount: () => fake.endpoint },
  );

  return Effect.gen(function* () {
    const failure = yield* Effect.flip(
      startAccount(plugin, gatewayContext(new AbortController().signal)),
    );

    expect(failure).toBeInstanceOf(OpenClawTestError);
    expect(events).toEqual([
      `record:${message.message.postId}:${sessionKeyFor(message.message.address)}`,
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
  const plugin = createMoltzapChannelPlugin(
    makeRuntime({ events, calls, routePeers: [] }),
    { harnessEndpointForAccount: () => fake.endpoint },
  );

  return Effect.gen(function* () {
    yield* startAccount(plugin, gatewayContext(new AbortController().signal));

    expect(calls).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("ack:"))).toHaveLength(2);
    expect(fake.sends).toHaveLength(2);
  });
}

function nativeSendUsesLocalReceiptIdentity() {
  const fake = makeListeningEndpoint();
  const plugin = createMoltzapChannelPlugin(
    makeRuntime({ events: [], calls: [], routePeers: [] }),
    { harnessEndpointForAccount: () => fake.endpoint },
  );
  const controller = new AbortController();
  const setStatus = vi.fn();

  return Effect.gen(function* () {
    const fiber = yield* startAccount(
      plugin,
      gatewayContext(controller.signal, setStatus),
    ).pipe(Effect.fork);
    yield* waitForConnected(setStatus);
    const { direct, group } = yield* executeNativeSends(plugin);

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
  });
}

function executeNativeSends(plugin: MoltZapPlugin) {
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
  const plugin = createMoltzapChannelPlugin(
    makeRuntime({ events: [], calls: [], routePeers: [] }),
    { harnessEndpointForAccount: () => fake.endpoint },
  );
  const controller = new AbortController();
  const setStatus = vi.fn();

  return Effect.gen(function* () {
    const fiber = yield* startAccount(
      plugin,
      gatewayContext(controller.signal, setStatus),
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
    params.events.push(
      `record:${input.ctx.MessageSid ?? "missing"}:${input.sessionKey}`,
    );
    return Promise.resolve();
  };
}

function makeReplyDispatcher(params: RuntimeFixtureParams): NativeDispatch {
  return (input) => {
    params.calls.push({ ctx: input.ctx, replyOptions: input.replyOptions });
    const messageId = input.ctx.MessageSid ?? "missing";
    if (params.failDispatch === true) {
      params.events.push(`dispatch-failed:${messageId}`);
      return Promise.reject(new Error("stock inbound callback failed"));
    }
    params.events.push(`dispatch:${messageId}`);
    return Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          input.dispatcherOptions.deliver(
            { text: "host final" },
            { kind: "final" },
          ),
        catch: (cause) => testError("deliverFinal", cause),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toEqual({ visibleReplySent: true });
          }),
        ),
        Effect.as({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 1 },
          sourceReplyDeliveryMode: "automatic" as const,
        }),
      ),
    );
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
  setStatus?: ReturnType<typeof vi.fn>,
): ChannelGatewayContext<{
  readonly id: string;
  readonly enabled?: boolean;
}> {
  let snapshot: ChannelAccountSnapshot = { accountId: ACCOUNT_ID };
  const statusSink = setStatus ?? vi.fn();
  return {
    cfg: makeConfig(),
    accountId: ACCOUNT_ID,
    account: { id: ACCOUNT_ID },
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

function makeConfig(): OpenClawConfig {
  return {
    channels: {
      moltzap: { accounts: [{ id: ACCOUNT_ID }] },
    },
    session: { store: TEST_SESSION_STORE_PATH },
  };
}

function startAccount(
  plugin: MoltZapPlugin,
  ctx: ChannelGatewayContext<{
    readonly id: string;
    readonly enabled?: boolean;
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
    SessionKey: sessionKeyFor(message.address),
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
    SessionKey: sessionKeyFor(message.address),
  });
}

function sessionKeyFor(address: string): string {
  return `agent:primary:moltzap:${address}`;
}
