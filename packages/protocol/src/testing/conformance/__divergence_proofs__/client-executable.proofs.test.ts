import { describe, expect, it } from "vitest";
import { Deferred, Effect, Exit, Ref, Scope } from "effect";
import * as fc from "fast-check";
import type {
  NotificationFrame,
  RequestFrame,
  ResponseFrame,
} from "../../../transport/index.js";
import {
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
} from "../../../task/index.js";
import type {
  TestServer,
  TestServerConnection,
} from "../_shared/driver/test-server.js";
import {
  makeCaptureBuffer,
  recordFrame,
  type CaptureBuffer,
} from "../_shared/captures.js";
import { encodeFrame } from "../_shared/frame-mutator.js";
import { requestFrame } from "../../index.js";
import { serverRpcMethods } from "../../../rpc-registry.js";
import type { AnyServerRpcDefinition } from "../../../rpc-registry.js";
import { jsonRpcMethod } from "../../../transport/index.js";
import type { ConformanceArtifact } from "../_shared/runner.js";
import {
  collectProperties,
  type PropertyFailure,
} from "../_shared/registry.js";
import {
  registerNotificationWellFormednessClient,
  registerMalformedFrameHandlingClient,
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
  registerFanOutCardinalityClient,
  registerPayloadOpacityClient,
  registerTaskBoundaryIsolationClient,
  registerArchiveLifecycleClient,
  registerSchemaExhaustiveFuzzClient,
} from "../client/index.js";
import {
  lookupTagForRawBytes,
  registerEmittedFrameTag,
} from "../client/runner.js";
import type {
  ClientConformanceRunContext,
  ClientHandshakeWindow,
  ObservedNotification,
  RealClientCloseEvent,
  RealClientNotificationSubscriber,
  RealClientHandle,
  RealClientRpcCaller,
  RealClientRpcError,
  RealClientSubscription,
} from "../client/index.js";
import {
  expectInvariant,
  runExpectingFailure,
} from "./executable-proof-helpers.js";

type EventBehavior =
  | "normal"
  | "scramble-position-index"
  | "strip-required-field"
  | "rewrite-payload"
  | "rewrite-conversation-id"
  | "swap-archive-lifecycle"
  | "close-on-malformed"
  | "close-on-untagged-fuzz";

type RpcBehavior = "normal" | "non-response-type" | "spurious-id";

interface BadClientOptions {
  readonly eventBehavior?: EventBehavior;
  readonly rpcBehavior?: RpcBehavior;
}

interface ClientProofCase {
  readonly title: string;
  readonly register: (ctx: ClientConformanceRunContext) => void;
  readonly opts: BadClientOptions;
  readonly invariantName: string;
  readonly timeoutMs?: number;
}

const CLIENT_PROOF_TIMEOUT_MS = 30_000;
const MALFORMED_FRAME_PROOF_TIMEOUT_MS = 10_000;

const CLIENT_PROOF_CASES: ReadonlyArray<ClientProofCase> = [
  {
    title:
      "registerNotificationWellFormednessClient fails when surfaced notifications lose required fields",
    register: registerNotificationWellFormednessClient,
    opts: { eventBehavior: "strip-required-field" },
    invariantName: "notification-well-formedness-client",
    timeoutMs: CLIENT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerFanOutCardinalityClient fails when a real client scrambles fan-out order",
    register: registerFanOutCardinalityClient,
    opts: { eventBehavior: "scramble-position-index" },
    invariantName: "fan-out-cardinality-client",
  },
  {
    title:
      "registerPayloadOpacityClient fails when a real client rewrites payload bytes",
    register: registerPayloadOpacityClient,
    opts: { eventBehavior: "rewrite-payload" },
    invariantName: "payload-opacity-client",
  },
  {
    title:
      "registerMalformedFrameHandlingClient fails when malformed frames poison liveness",
    register: registerMalformedFrameHandlingClient,
    opts: { eventBehavior: "close-on-malformed" },
    invariantName: "malformed-frame-handling-client",
    timeoutMs: MALFORMED_FRAME_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerTaskBoundaryIsolationClient fails when task ids are cross-wired",
    register: registerTaskBoundaryIsolationClient,
    opts: { eventBehavior: "rewrite-conversation-id" },
    invariantName: "task-boundary-isolation-client",
  },
  {
    title:
      "registerArchiveLifecycleClient fails when archive lifecycle order is wrong",
    register: registerArchiveLifecycleClient,
    opts: { eventBehavior: "swap-archive-lifecycle" },
    invariantName: "archive-lifecycle-client",
  },
  {
    title:
      "registerSchemaExhaustiveFuzzClient fails when post-fuzz liveness is poisoned",
    register: registerSchemaExhaustiveFuzzClient,
    opts: { eventBehavior: "close-on-untagged-fuzz" },
    invariantName: "schema-exhaustive-fuzz-client",
  },
  {
    title:
      "registerModelEquivalenceClient fails when RPC returns a non-response frame",
    register: registerModelEquivalenceClient,
    opts: { rpcBehavior: "non-response-type" },
    invariantName: "model-equivalence-client",
  },
  {
    title:
      "registerRequestIdUniquenessClient fails when RPC resolves via a spurious id",
    register: registerRequestIdUniquenessClient,
    opts: { rpcBehavior: "spurious-id" },
    invariantName: "request-id-uniqueness-client",
  },
];

describe("client-side conformance executable divergence proofs", () => {
  it("proof matrix maps every case to one invariant name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLIENT_PROOF_CASES),
        hasUniqueInvariantName,
      ),
    );
    expect(CLIENT_PROOF_CASES).toHaveLength(9);
  });

  for (const proof of CLIENT_PROOF_CASES) {
    it(
      proof.title,
      () => {
        expect.hasAssertions();
        return Effect.runPromise(runClientProofCase(proof));
      },
      proof.timeoutMs,
    );
  }
});

function hasUniqueInvariantName(proof: ClientProofCase): boolean {
  return countProofsByInvariantName(proof.invariantName) === 1;
}

function countProofsByInvariantName(invariantName: string): number {
  let count = 0;
  for (const candidate of CLIENT_PROOF_CASES) {
    if (candidate.invariantName === invariantName) count += 1;
  }
  return count;
}

const runClientProofCase = (proof: ClientProofCase): Effect.Effect<void> =>
  Effect.gen(function* () {
    const failure = yield* runSingleClientProof(proof.register, proof.opts);
    expectInvariant(failure, proof.invariantName);
  });

function runSingleClientProof(
  register: (ctx: ClientConformanceRunContext) => void,
  opts: BadClientOptions,
): Effect.Effect<PropertyFailure> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* makeBadClientContext(opts);
          register(ctx);
          const properties = collectProperties(ctx);
          if (properties.length !== 1) {
            return yield* Effect.die(
              new Error(`expected one property, got ${properties.length}`),
            );
          }
          return yield* runExpectingFailure(properties[0]!);
        }),
      ),
    );
    if (Exit.isFailure(exit)) {
      return yield* Effect.die(
        new Error(`proof harness defect: ${exit.cause.toString()}`),
      );
    }
    return exit.value;
  });
}

type BadClientPendingDeferred = Deferred.Deferred<
  ResponseFrame | NotificationFrame,
  RealClientRpcError
>;

type BadClientPendingMap = ReadonlyMap<string, BadClientPendingDeferred>;

interface BadClientRuntime {
  readonly opts: BadClientOptions;
  readonly eventsRef: Ref.Ref<ReadonlyArray<ObservedNotification>>;
  readonly closeRef: Ref.Ref<RealClientCloseEvent | null>;
  readonly connectionRef: Ref.Ref<TestServerConnection | null>;
  readonly pendingRef: Ref.Ref<BadClientPendingMap>;
  readonly bufferedResponseRef: Ref.Ref<ResponseFrame | null>;
  readonly artifacts: Ref.Ref<ReadonlyArray<ConformanceArtifact>>;
  readonly inbound: CaptureBuffer;
  readonly requestCounterRef: Ref.Ref<number>;
  readonly tagCounterRef: Ref.Ref<number>;
}

interface PendingRpc {
  readonly id: string;
  readonly deferred: BadClientPendingDeferred;
}

interface BadClientContextParts {
  readonly runtime: BadClientRuntime;
  readonly connection: TestServerConnection;
  readonly handle: RealClientHandle;
  readonly handshakeWindow: ClientHandshakeWindow;
}

function makeBadClientContext(
  opts: BadClientOptions,
): Effect.Effect<ClientConformanceRunContext, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* makeBadClientRuntime(opts);
    const connection = makeBadServerConnection(runtime);
    yield* Ref.set(runtime.connectionRef, connection);
    const handle = makeBadClientHandle(runtime);
    const handshakeWindow = makeBadHandshakeWindow(runtime);
    return makeBadClientRunContext({
      runtime,
      connection,
      handle,
      handshakeWindow,
    });
  });
}

function makeBadClientRuntime(
  opts: BadClientOptions,
): Effect.Effect<BadClientRuntime> {
  return Effect.gen(function* () {
    return {
      opts,
      eventsRef: yield* Ref.make<ReadonlyArray<ObservedNotification>>([]),
      closeRef: yield* Ref.make<RealClientCloseEvent | null>(null),
      connectionRef: yield* Ref.make<TestServerConnection | null>(null),
      pendingRef: yield* Ref.make<BadClientPendingMap>(new Map()),
      bufferedResponseRef: yield* Ref.make<ResponseFrame | null>(null),
      artifacts: yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]),
      inbound: yield* makeCaptureBuffer({ capacity: 256 }),
      requestCounterRef: yield* Ref.make(0),
      tagCounterRef: yield* Ref.make(0),
    };
  });
}

function makeBadServerConnection(
  runtime: BadClientRuntime,
): TestServerConnection {
  return {
    connectionId: "bad-client-proof-connection",
    remoteAddr: "in-memory",
    inbound: runtime.inbound,
    emitNotification: (notification) =>
      publishNotification(runtime, notification),
    emitResponse: (response) => resolveResponse(runtime, response),
    emitMalformed: () => emitMalformed(runtime),
    close: (close) => setClose(runtime, close.code, close.reason),
  };
}

function publishNotification(
  runtime: BadClientRuntime,
  frame: NotificationFrame,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const behavior = eventBehavior(runtime);
    const close = yield* Ref.get(runtime.closeRef);
    if (close !== null && behavior === "close-on-malformed") return;
    const tag = lookupTagForRawBytes(encodedFrameBytes(frame));
    yield* closeOnUntaggedFuzz(runtime, behavior, tag);
    const surfaceFrame = surfaceNotificationFrame(behavior, frame);
    yield* appendObservedNotification(runtime, surfaceFrame, tag);
  });
}

function encodedFrameBytes(frame: NotificationFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

function closeOnUntaggedFuzz(
  runtime: BadClientRuntime,
  behavior: EventBehavior,
  tag: string | null,
): Effect.Effect<void> {
  return behavior === "close-on-untagged-fuzz" && tag === null
    ? setClose(runtime, 1002, "bad client closed during fuzz")
    : Effect.void;
}

function surfaceNotificationFrame(
  behavior: EventBehavior,
  frame: NotificationFrame,
): unknown {
  switch (behavior) {
    case "strip-required-field":
      return stripNotificationName(frame);
    case "scramble-position-index":
      return scrambleMessagePart(frame);
    case "rewrite-payload":
      return rewriteMessagePatchedBy(frame, "rewritten");
    case "rewrite-conversation-id":
      return rewriteMessageConversationId(frame, "cross-wired-task");
    case "swap-archive-lifecycle":
      return swapArchiveLifecycleNotification(frame);
    default:
      return frame;
  }
}

function appendObservedNotification(
  runtime: BadClientRuntime,
  decoded: unknown,
  emissionTag: string | null,
): Effect.Effect<void> {
  const rawBytes = new TextEncoder().encode(JSON.stringify(decoded));
  return Ref.update(runtime.eventsRef, (events) => [
    ...events,
    { emissionTag, decoded, rawBytes, observedAtMs: Date.now() },
  ]);
}

function resolveResponse(
  runtime: BadClientRuntime,
  response: ResponseFrame,
): Effect.Effect<void> {
  const behavior = rpcBehavior(runtime);
  return behavior === "spurious-id"
    ? resolveSpuriousResponse(runtime, response)
    : resolveCorrelatedResponse(runtime, response, behavior);
}

function resolveSpuriousResponse(
  runtime: BadClientRuntime,
  response: ResponseFrame,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pending = yield* Ref.get(runtime.pendingRef);
    const pendingId = firstPendingId(pending);
    if (pendingId === null) {
      yield* Ref.set(runtime.bufferedResponseRef, response);
      return;
    }
    const deferred = pending.get(pendingId);
    if (deferred === undefined) return;
    yield* Deferred.succeed(deferred, response);
  });
}

function firstPendingId(pending: BadClientPendingMap): string | null {
  const candidate = pending.keys().next().value;
  return typeof candidate === "string" ? candidate : null;
}

function resolveCorrelatedResponse(
  runtime: BadClientRuntime,
  response: ResponseFrame,
  behavior: RpcBehavior,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (typeof response.id !== "string") return;
    const pending = yield* Ref.get(runtime.pendingRef);
    const deferred = pending.get(response.id);
    if (deferred === undefined) return;
    yield* Deferred.succeed(deferred, responseForBehavior(response, behavior));
  });
}

function responseForBehavior(
  response: ResponseFrame,
  behavior: RpcBehavior,
): ResponseFrame | NotificationFrame {
  return behavior === "non-response-type"
    ? ({
        jsonrpc: "2.0",
        method: jsonRpcMethod("proof/non-response"),
        params: response,
      } as NotificationFrame)
    : response;
}

function emitMalformed(runtime: BadClientRuntime): Effect.Effect<void> {
  return eventBehavior(runtime) === "close-on-malformed"
    ? setClose(runtime, 1002, "bad client closed on malformed frame")
    : Effect.void;
}

function setClose(
  runtime: BadClientRuntime,
  code: number,
  reason: string,
): Effect.Effect<void> {
  return Ref.set(runtime.closeRef, {
    code,
    reason,
    observedAtMs: Date.now(),
  });
}

function makeBadClientHandle(runtime: BadClientRuntime): RealClientHandle {
  return {
    agentId: "00000000-0000-4000-8000-baadc11e7e57",
    ready: Effect.void,
    notifications: makeNotificationSubscriber(runtime),
    call: makeRpcCaller(runtime),
    closeSignal: waitForCloseSignal(runtime),
    close: Effect.void,
  };
}

function makeNotificationSubscriber(
  runtime: BadClientRuntime,
): RealClientNotificationSubscriber {
  return {
    subscribe: () =>
      Effect.succeed({
        id: "bad-client-proof-subscription",
        unsubscribe: Effect.void,
      } satisfies RealClientSubscription),
    snapshot: Ref.get(runtime.eventsRef),
  };
}

function makeRpcCaller(runtime: BadClientRuntime): RealClientRpcCaller {
  return {
    call: (method, params) => callBadClientRpc(runtime, method, params),
  };
}

function callBadClientRpc(
  runtime: BadClientRuntime,
  method: string,
  params: unknown,
): ReturnType<RealClientRpcCaller["call"]> {
  return Effect.gen(function* () {
    const pending = yield* openPendingRpc(runtime);
    yield* flushBufferedSpuriousResponse(runtime, pending.deferred);
    const connection = yield* requireConnection(runtime);
    const request = yield* makeProofRequest(pending.id, method, params);
    yield* recordFrame(
      connection.inbound,
      "inbound",
      encodeFrame(request),
      request,
    );
    return yield* Deferred.await(pending.deferred);
  });
}

function openPendingRpc(runtime: BadClientRuntime): Effect.Effect<PendingRpc> {
  return Effect.gen(function* () {
    const id = yield* nextRpcId(runtime);
    const deferred = yield* Deferred.make<
      ResponseFrame | NotificationFrame,
      RealClientRpcError
    >();
    yield* Ref.update(
      runtime.pendingRef,
      (pending) => new Map([...pending, [id, deferred]]),
    );
    return { id, deferred };
  });
}

function nextRpcId(runtime: BadClientRuntime): Effect.Effect<string> {
  return Ref.modify(runtime.requestCounterRef, (count) => {
    const next = count + 1;
    return [`rpc-${next}`, next];
  });
}

function flushBufferedSpuriousResponse(
  runtime: BadClientRuntime,
  deferred: BadClientPendingDeferred,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (rpcBehavior(runtime) !== "spurious-id") return;
    const buffered = yield* Ref.get(runtime.bufferedResponseRef);
    if (buffered === null) return;
    yield* Ref.set(runtime.bufferedResponseRef, null);
    yield* Deferred.succeed(deferred, buffered);
  });
}

function requireConnection(
  runtime: BadClientRuntime,
): Effect.Effect<TestServerConnection> {
  return Effect.gen(function* () {
    const connection = yield* Ref.get(runtime.connectionRef);
    if (connection !== null) return connection;
    return yield* Effect.die(new Error("connection not initialized"));
  });
}

function makeProofRequest(
  id: string,
  method: string,
  params: unknown,
): Effect.Effect<RequestFrame> {
  return Effect.gen(function* () {
    const definition: AnyServerRpcDefinition | undefined =
      serverRpcMethods.find((def) => def.name === method);
    if (definition === undefined || !definition.validateParams(params)) {
      return yield* Effect.die(new Error(`invalid proof RPC: ${method}`));
    }
    return requestFrame(id, definition, params);
  });
}

function waitForCloseSignal(
  runtime: BadClientRuntime,
): Effect.Effect<RealClientCloseEvent> {
  return Effect.gen(function* () {
    while (true) {
      const close = yield* Ref.get(runtime.closeRef);
      if (close !== null) return close;
      yield* Effect.sleep("10 millis");
    }
  });
}

function makeBadHandshakeWindow(
  runtime: BadClientRuntime,
): ClientHandshakeWindow {
  return {
    freshEmissionTag: nextBadProofTag(runtime),
    emitTaggedNotification: (input) => emitTaggedNotification(input),
    emitTaggedResponse: (input) => emitTaggedResponse(input),
    awaitHandshakeComplete: Effect.void,
  };
}

function nextBadProofTag(runtime: BadClientRuntime): Effect.Effect<string> {
  return Ref.modify(runtime.tagCounterRef, (count) => {
    const next = count + 1;
    return [`bad-proof-tag-${next}`, next];
  });
}

function emitTaggedNotification(
  input: Parameters<ClientHandshakeWindow["emitTaggedNotification"]>[0],
): ReturnType<ClientHandshakeWindow["emitTaggedNotification"]> {
  registerEmittedFrameTag(JSON.stringify(input.base), input.emissionTag);
  return input.connection.emitNotification(input.base).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.as(input.emissionTag),
  );
}

function emitTaggedResponse(
  input: Parameters<ClientHandshakeWindow["emitTaggedResponse"]>[0],
): ReturnType<ClientHandshakeWindow["emitTaggedResponse"]> {
  const tag =
    typeof input.base.id === "string" ? input.base.id : input.emissionTag;
  return input.connection.emitResponse(input.base).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.as(tag),
  );
}

function makeBadClientRunContext(
  parts: BadClientContextParts,
): ClientConformanceRunContext {
  const testServer = makeBadTestServer(parts.runtime, parts.connection);
  return {
    testServer,
    realClientFactory: () => Effect.succeed(parts.handle),
    handshakeWindow: parts.handshakeWindow,
    toxiproxy: null,
    opts: {
      tiers: ["A", "B", "C", "E"],
      realClient: () => Effect.succeed(parts.handle),
    },
    seed: 42,
    artifacts: parts.runtime.artifacts,
  };
}

function makeBadTestServer(
  runtime: BadClientRuntime,
  connection: TestServerConnection,
): TestServer {
  return {
    wsUrl: "ws://bad-client-proof.invalid",
    accept: Effect.succeed(connection),
    connections: Effect.succeed([connection]),
    allInbound: runtime.inbound,
    snapshot: runtime.inbound.snapshot,
  };
}

function eventBehavior(runtime: BadClientRuntime): EventBehavior {
  return runtime.opts.eventBehavior ?? "normal";
}

function rpcBehavior(runtime: BadClientRuntime): RpcBehavior {
  return runtime.opts.rpcBehavior ?? "normal";
}

function stripNotificationName(frame: NotificationFrame): unknown {
  return Object.fromEntries(
    Object.entries(frame).filter(([key]) => key !== "method"),
  );
}

const EMPTY_OBJECT: Readonly<Record<string, unknown>> = {};

function objectOrEmpty(value: unknown): Readonly<Record<string, unknown>> {
  return isObject(value) ? value : EMPTY_OBJECT;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Bug-injection: rewrite the message's `parts[0].text` so the C1
 * cardinality predicate observes a duplicate tag-position binding (the
 * test post-Phase-12 keys uniqueness on wire bytes; clobbering the part
 * text collapses two emissions onto the same wire form).
 */
function scrambleMessagePart(frame: NotificationFrame): NotificationFrame {
  const params = objectOrEmpty(frame.params);
  const message = objectOrEmpty(params.message);
  return {
    ...frame,
    params: {
      ...params,
      message: { ...message, parts: [{ type: "text", text: "scrambled" }] },
    },
  } as NotificationFrame;
}

/**
 * Bug-injection: overwrite `message.patchedBy` so the C3 payload-
 * opacity predicate cannot find its marker token in the surfaced raw
 * frame.
 */
function rewriteMessagePatchedBy(
  frame: NotificationFrame,
  newPatchedBy: string,
): NotificationFrame {
  const params = objectOrEmpty(frame.params);
  const message = objectOrEmpty(params.message);
  return {
    ...frame,
    params: {
      ...params,
      message: { ...message, patchedBy: newPatchedBy },
    },
  } as NotificationFrame;
}

/**
 * Bug-injection: cross-wire `params.conversationId` so the C4 task-
 * boundary predicate detects the rewritten id on the surfaced
 * observation.
 */
function rewriteMessageConversationId(
  frame: NotificationFrame,
  newId: string,
): NotificationFrame {
  const params = objectOrEmpty(frame.params);
  return {
    ...frame,
    params: { ...params, conversationId: newId },
  } as NotificationFrame;
}

function swapArchiveLifecycleNotification(
  frame: NotificationFrame,
): NotificationFrame {
  if (frame.method === TaskConversationArchivedNotificationDefinition.name) {
    return {
      ...frame,
      method: TaskConversationUnarchivedNotificationDefinition.name,
    } as NotificationFrame;
  }
  if (frame.method === TaskConversationUnarchivedNotificationDefinition.name) {
    return {
      ...frame,
      method: TaskConversationArchivedNotificationDefinition.name,
    } as NotificationFrame;
  }
  return frame;
}
