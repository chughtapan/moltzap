/**
 * Real-client conformance adapter.
 *
 * Wraps `MoltZapAgentClient` into the `RealClientHandle` shape that
 * `@moltzap/protocol/testing` `runClientConformanceSuite` consumes.
 *
 * `RealClientNotificationFilter` is a `(notification) => boolean`
 * predicate; the adapter plumbs it directly onto the Stream-based
 * `MoltZapAgentClient.subscribeAll` surface.
 *
 * Consumed by:
 *   - `packages/client/src/__tests__/conformance/suite.test.ts` directly
 *   - `packages/openclaw-channel/src/test-support.ts` (re-exported via
 *     `@moltzap/openclaw-channel/test-support`)
 *   - `packages/nanoclaw-channel/src/test-support.ts` (same)
 */
import { Data, Effect, Either, Ref, Scope, Stream } from "effect";
import {
  AgentCallableGroup,
  serverRpcMethods,
  type AnyServerRpcDefinition,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type NotificationFrame,
  type ResponseFrame,
} from "@moltzap/protocol";
import type { RpcGroup, Rpc } from "@effect/rpc";
import type {
  RealClientCloseEvent,
  RealClientNotificationFilter,
  RealClientHandle,
  RealClientNotificationSubscriber,
  RealClientLifecycleError,
  RealClientRpcError,
  RealClientRpcCaller,
  RealClientSubscription,
  ObservedNotification,
} from "@moltzap/protocol/testing";
import { MoltZapAgentClient, type CloseInfo } from "@moltzap/client";
import { NotConnectedError, RpcTimeoutError } from "@moltzap/protocol";

const CONNECT_READY_TIMEOUT_MS = 30_000;
type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
/** The error channel of an agent client `call`: per-method errors + transport. */
type ClientRpcCause =
  | Rpc.Error<AgentCallableRpcs>
  | RpcTimeoutError
  | NotConnectedError;
type ReadyState = "pending" | "resolved" | { readonly cause: unknown };

/**
 * Options for the adapter factory. `agentKey` and `agentId` are caller-
 * supplied; the TestServer URL is supplied by the conformance suite at
 * invocation time via the `RealClientFactoryArgs` argument the suite
 * passes on every call.
 */
export interface RealClientFactoryOptions {
  readonly agentKey: string;
  readonly agentId: string;
}

class RealClientLifecycleFailure extends Data.TaggedError(
  "RealClientLifecycleError",
)<{
  readonly cause: unknown;
}> {}

class RealClientRpcFailure extends Data.TaggedError("RealClientRpcError")<{
  readonly cause: unknown;
  readonly documentedErrorTag: string | null;
  readonly kind: RealClientRpcError["kind"];
  readonly method: string;
}> {}

function lifecycleError(cause: unknown): RealClientLifecycleError {
  return new RealClientLifecycleFailure({ cause }) as RealClientLifecycleError;
}

function rpcError(cause: ClientRpcCause, method: string): RealClientRpcError {
  if (cause instanceof RpcTimeoutError) {
    return new RealClientRpcFailure({
      cause,
      documentedErrorTag: "RpcTimeoutError",
      kind: "timeout",
      method,
    }) as RealClientRpcError;
  }
  if (cause instanceof NotConnectedError) {
    return new RealClientRpcFailure({
      cause,
      documentedErrorTag: "NotConnectedError",
      kind: "disconnected",
      method,
    }) as RealClientRpcError;
  }
  return new RealClientRpcFailure({
    cause,
    documentedErrorTag: typeof cause._tag === "string" ? cause._tag : null,
    kind: "server-error",
    method,
  }) as RealClientRpcError;
}

function rpcErrorForMethod(
  method: string,
): (cause: ClientRpcCause) => RealClientRpcError {
  return (cause) => rpcError(cause, method);
}

function logConformanceAdapterWarning(message: string, cause: unknown): void {
  Effect.runSync(
    Effect.logWarning(message).pipe(
      Effect.annotateLogs({ cause: String(cause) }),
    ),
  );
}

function closeEventFromInfo(close: CloseInfo): RealClientCloseEvent {
  return {
    code: close.code,
    reason: close.reason,
    observedAtMs: Date.now(),
  };
}

function recordCloseEvent(
  closeRef: Ref.Ref<RealClientCloseEvent | null>,
  close: CloseInfo,
): void {
  try {
    Effect.runSync(
      Ref.update(closeRef, (current) => current ?? closeEventFromInfo(close)),
    );
  } catch (closeErr) {
    logConformanceAdapterWarning(
      "failed to record conformance close event",
      closeErr,
    );
  }
}

function observedNotificationFromDecoded(
  notification: DecodedNotification<AnyNotificationDefinition>,
): ObservedNotification {
  // The protocol-side ObservedNotification contract carries a wire-shaped
  // `NotificationFrame` in `decoded`. Reconstruct it from the decoded view.
  const wireFrame: NotificationFrame = {
    jsonrpc: notification.jsonrpc,
    method: notification.method,
    ...(notification.params !== undefined
      ? // eslint-disable-next-line agent-code-guard/record-cast -- wire-shape rebuild for the protocol ObservedNotification contract; params provenance is the decoded notification itself
        { params: notification.params as Record<string, unknown> }
      : {}),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(wireFrame));
  return {
    emissionTag: null,
    decoded: wireFrame,
    rawBytes: encoded,
    observedAtMs: Date.now(),
  };
}

function recordObservedNotification(
  notificationsRef: Ref.Ref<ReadonlyArray<ObservedNotification>>,
  notification: DecodedNotification<AnyNotificationDefinition>,
): Effect.Effect<void> {
  const obs = observedNotificationFromDecoded(notification);
  return Ref.update(notificationsRef, (xs) => [...xs, obs]);
}

function resolveRpcDefinition(
  method: string,
  params: unknown,
): Effect.Effect<AnyServerRpcDefinition, RealClientRpcError> {
  const definition = serverRpcMethods.find(
    (d): d is AnyServerRpcDefinition => d.name === method,
  );
  if (definition !== undefined && definition.validateParams(params)) {
    return Effect.succeed(definition);
  }
  return Effect.fail(
    new RealClientRpcFailure({
      cause: { method, params },
      documentedErrorTag: null,
      kind: "malformed-response",
      method,
    }) as RealClientRpcError,
  );
}

function makeConformanceClient(
  args: { readonly testServerUrl: string },
  opts: RealClientFactoryOptions,
  closeRef: Ref.Ref<RealClientCloseEvent | null>,
): MoltZapAgentClient {
  return new MoltZapAgentClient({
    serverUrl: args.testServerUrl,
    agentKey: opts.agentKey,
    onDisconnect: (close: CloseInfo) => recordCloseEvent(closeRef, close),
  });
}

/**
 * Fork a `subscribeAll → runForEach` consumer into the ambient `Scope` so
 * every inbound notification gets recorded into `notificationsRef`. The
 * fiber is cancelled when the scope ends (factory caller's
 * `Scope.CloseableScope`); on terminal close the Stream fails with
 * `NotConnectedError` which we log + swallow.
 */
function forkCaptureAllNotifications(
  ws: MoltZapAgentClient,
  notificationsRef: Ref.Ref<ReadonlyArray<ObservedNotification>>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.forkScoped(
    ws.subscribeAll().pipe(
      Stream.runForEach((notification) =>
        recordObservedNotification(notificationsRef, notification),
      ),
      Effect.catchAll((cause) =>
        Effect.logWarning(
          "conformance adapter capture-all Stream terminated",
          cause,
        ),
      ),
      Effect.asVoid,
    ),
  ).pipe(Effect.asVoid);
}

function addClientFinalizer(
  ws: MoltZapAgentClient,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.addFinalizer(() => ws.close());
}

function forkReadyWatcher(
  ws: MoltZapAgentClient,
  readyRef: Ref.Ref<ReadyState>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.forkScoped(
    ws.connect().pipe(
      Effect.either,
      Effect.flatMap(
        Either.match({
          onLeft: (cause) => Ref.set(readyRef, { cause }),
          onRight: () => Ref.set(readyRef, "resolved"),
        }),
      ),
    ),
  ).pipe(Effect.asVoid);
}

function waitForReady(
  readyRef: Ref.Ref<ReadyState>,
): Effect.Effect<void, RealClientLifecycleError> {
  return Effect.gen(function* () {
    const deadline = Date.now() + CONNECT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = yield* Ref.get(readyRef);
      if (state === "resolved") return;
      if (typeof state === "object") {
        return yield* Effect.fail(lifecycleError(state.cause));
      }
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.fail(lifecycleError("connect timeout"));
  });
}

/**
 * Subscribe to filtered notifications through the `subscribeAll` Stream.
 * `RealClientNotificationFilter` is itself a `(notification) => boolean`
 * predicate, plumbed through directly.
 *
 * The returned `RealClientSubscription` carries an `unsubscribe` Effect
 * that interrupts the forked consumer fiber, draining its Scope finalizer
 * chain (which in turn invokes the registry's `unregister` from the
 * `Stream.async` callback).
 */
function subscribeRealClient(
  ws: MoltZapAgentClient,
  filter: RealClientNotificationFilter | undefined,
): Effect.Effect<
  RealClientSubscription,
  RealClientLifecycleError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    // Spawn a scoped child scope so we can selectively unsubscribe.
    const subScope = yield* Scope.make();
    const consumeEffect = ws.subscribeAll(filter).pipe(
      Stream.runForEach(() => Effect.void),
      Effect.catchAll(() => Effect.void),
      Effect.asVoid,
    );
    yield* Effect.forkIn(consumeEffect, subScope);
    // Subscription id is for test-side bookkeeping (unsubscribe lookup);
    // not security-sensitive. Suppress sonarjs/pseudo-random.
    // eslint-disable-next-line sonarjs/pseudo-random -- test bookkeeping id, no security boundary
    const id = `subscribe-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    return {
      id,
      unsubscribe: Scope.close(subScope, Effect.void as never).pipe(
        Effect.asVoid,
      ),
    } satisfies RealClientSubscription;
  }).pipe(Effect.mapError((cause) => lifecycleError(cause)));
}

function makeNotificationSubscriber(
  ws: MoltZapAgentClient,
  notificationsRef: Ref.Ref<ReadonlyArray<ObservedNotification>>,
): RealClientNotificationSubscriber {
  return {
    subscribe: (filter) =>
      subscribeRealClient(ws, filter) as Effect.Effect<
        RealClientSubscription,
        RealClientLifecycleError
      >,
    snapshot: Ref.get(notificationsRef),
  };
}

/**
 * Name-indexed dispatch over the agent-callable methods: forward an
 * already-validated payload to the live client's typed `call` for a fixed tag.
 * Built once from the agent group's request set; consumption (`.get(method)`)
 * is cast-free. The construction launders the group's `string` request keys
 * into the `AgentCallableTag` the typed `call` requires — the live request set
 * IS the agent-callable tags, and the params are descriptor-validated.
 */
const AGENT_CALL_DISPATCH: ReadonlyMap<
  string,
  (
    ws: MoltZapAgentClient,
    params: unknown,
  ) => Effect.Effect<unknown, ClientRpcCause>
> = new Map(
  [...AgentCallableGroup.requests.keys()].map((tag) => [
    tag,
    (ws: MoltZapAgentClient, params: unknown) =>
      ws.call(
        tag as Parameters<MoltZapAgentClient["call"]>[0],
        params as Parameters<MoltZapAgentClient["call"]>[1],
      ),
  ]),
);

function callRealClientRpc(
  ws: MoltZapAgentClient,
  method: string,
  params: unknown,
): Effect.Effect<ResponseFrame, RealClientRpcError> {
  return Effect.gen(function* () {
    const definition = yield* resolveRpcDefinition(method, params);
    const dispatch = AGENT_CALL_DISPATCH.get(method);
    if (dispatch === undefined) {
      return yield* Effect.fail(
        new RealClientRpcFailure({
          cause: { method },
          documentedErrorTag: null,
          kind: "malformed-response",
          method,
        }) as RealClientRpcError,
      );
    }
    const result = yield* dispatch(ws, params).pipe(
      Effect.mapError(rpcErrorForMethod(method)),
    );
    return definition.encodeResponse(null, result) as ResponseFrame;
  });
}

function makeRpcCaller(ws: MoltZapAgentClient): RealClientRpcCaller {
  return {
    call: (method, params) => callRealClientRpc(ws, method, params),
  };
}

function closeSignalEffect(
  closeRef: Ref.Ref<RealClientCloseEvent | null>,
): Effect.Effect<RealClientCloseEvent> {
  return Effect.gen(function* () {
    while (true) {
      const cur = yield* Ref.get(closeRef);
      if (cur !== null) return cur;
      yield* Effect.sleep("25 millis");
    }
  });
}

/**
 * Build a `RealClientHandle` factory that the protocol conformance suite
 * can invoke. The returned factory creates a fresh `MoltZapAgentClient`,
 * opens its WebSocket, and exposes the client's public surface through
 * the `RealClientHandle` interface.
 */
export function createMoltZapRealClientFactory(
  opts: RealClientFactoryOptions,
): (args: {
  readonly testServerUrl: string;
}) => Effect.Effect<RealClientHandle, RealClientLifecycleError, Scope.Scope> {
  return (args) =>
    Effect.gen(function* () {
      const notificationsRef = yield* Ref.make<
        ReadonlyArray<ObservedNotification>
      >([]);
      const closeRef = yield* Ref.make<RealClientCloseEvent | null>(null);
      const ws = makeConformanceClient(args, opts, closeRef);
      yield* forkCaptureAllNotifications(ws, notificationsRef);

      yield* addClientFinalizer(ws);
      const readyRef = yield* Ref.make<ReadyState>("pending");
      yield* forkReadyWatcher(ws, readyRef);

      return {
        agentId: opts.agentId,
        ready: waitForReady(readyRef),
        notifications: makeNotificationSubscriber(ws, notificationsRef),
        call: makeRpcCaller(ws),
        closeSignal: closeSignalEffect(closeRef),
        close: ws.close(),
      } satisfies RealClientHandle;
    }).pipe(Effect.withSpan("createMoltZapRealClientFactory"));
}
