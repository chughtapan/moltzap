/**
 * Real-client conformance adapter.
 *
 * Wraps `MoltZapWsClient` into the `RealClientHandle` shape that
 * `@moltzap/protocol/testing` `runClientConformanceSuite` consumes.
 *
 * Consumed by:
 *   - `packages/client/src/__tests__/conformance/suite.test.ts` directly
 *   - `packages/openclaw-channel/src/test-support.ts` (re-exported via
 *     `@moltzap/openclaw-channel/test-support`)
 *   - `packages/nanoclaw-channel/src/test-support.ts` (same)
 *
 * Every field this adapter publishes is derived from `MoltZapWsClient`'s
 * public API (`connect`, `close`, `sendRpcTracked`, `subscribe`,
 * `onDisconnect`): no private reads, no monkey-patching
 * (Invariant I9 from spec #200).
 *
 * Phase 12 encapsulation: request ids are wire metadata, not part of the
 * test-protocol surface. The adapter calls `ws.sendRpc(...)` (no id leak)
 * and synthesizes a wire-shaped `ResponseFrame` with `id: null` for the
 * conformance contract. Tests that need to verify id-correlation (B4)
 * discriminate via `result` payload content instead of reading ids back.
 *   - `closeRef` is populated from `CloseInfo.{code, reason}` passed
 *     into `onDisconnect`, not the hardcoded `{1000, "disconnect"}`
 *     (V7).
 *   - `subscribe` registers a real per-filter handle on the client; the
 *     no-op stub is gone (C4 + subscribe-stub).
 */
import { Data, Effect, Either, Ref, Scope } from "effect";
import {
  rpcMethods,
  type AnyRpcDefinition,
  type NotificationFrame,
  type ParamsOf,
  type ResponseFrame,
  type RpcCallError,
} from "@moltzap/protocol";
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
import { MoltZapWsClient, type CloseInfo } from "@moltzap/client";
import type { SubscriptionFilter } from "@moltzap/client/runtime";
import {
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/protocol";

const CONNECT_READY_TIMEOUT_MS = 30_000;
type ClientRpcCause = RpcCallError | RpcTimeoutError;
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
  // Struct-shaped value rather than a `new RealClientLifecycleError` — the
  // protocol's `runner.ts` defines the class, but this adapter ships in
  // `@moltzap/client` which consumes the protocol package as a leaf (can't
  // cross-import the class without creating a cycle via typings alone). The
  // shape matches 1:1 so callers that discriminate on `_tag` work.
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
  if (cause instanceof RpcServerError) {
    return new RealClientRpcFailure({
      cause,
      documentedErrorTag: "RpcServerError",
      kind: "server-error",
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

/**
 * Project a `RealClientNotificationFilter` (protocol-side shape) onto a
 * `SubscriptionFilter` (client-side shape). One-for-one field mapping
 * — both interfaces share the same three optional fields by design.
 */
function filterFromRealClient(
  filter: RealClientNotificationFilter,
): SubscriptionFilter {
  return {
    emissionTag: filter.emissionTag,
    conversationId: filter.conversationId,
    notificationNamePrefix: filter.notificationNamePrefix,
  };
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

function observedNotificationFromFrame(
  frame: NotificationFrame,
): ObservedNotification {
  const wireFrame: NotificationFrame = {
    jsonrpc: frame.jsonrpc,
    method: frame.method,
    ...(frame.params !== undefined ? { params: frame.params } : {}),
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
  frame: NotificationFrame,
): void {
  const obs = observedNotificationFromFrame(frame);
  try {
    Effect.runSync(Ref.update(notificationsRef, (xs) => [...xs, obs]));
  } catch (recordErr) {
    logConformanceAdapterWarning(
      "failed to record conformance observation",
      recordErr,
    );
  }
}

function resolveRpcDefinition(
  method: string,
  params: unknown,
): Effect.Effect<AnyRpcDefinition, RealClientRpcError> {
  const definition = rpcMethods.find(
    (d): d is AnyRpcDefinition => d.name === method,
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
): MoltZapWsClient {
  return new MoltZapWsClient({
    serverUrl: args.testServerUrl,
    agentKey: opts.agentKey,
    onDisconnect: (close: CloseInfo) => recordCloseEvent(closeRef, close),
  });
}

function captureAllNotifications(
  ws: MoltZapWsClient,
  notificationsRef: Ref.Ref<ReadonlyArray<ObservedNotification>>,
): Effect.Effect<RealClientSubscription, RealClientLifecycleError> {
  return ws
    .subscribe({}, (frame: NotificationFrame) =>
      Effect.sync(() => {
        recordObservedNotification(notificationsRef, frame);
      }),
    )
    .pipe(Effect.mapError((cause) => lifecycleError(cause)));
}

function addClientFinalizer(
  ws: MoltZapWsClient,
  captureAll: RealClientSubscription,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.addFinalizer(() =>
    captureAll.unsubscribe.pipe(Effect.zipRight(ws.close())),
  );
}

function forkReadyWatcher(
  ws: MoltZapWsClient,
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

function subscribeRealClient(
  ws: MoltZapWsClient,
  filter: RealClientNotificationFilter,
): Effect.Effect<RealClientSubscription, RealClientLifecycleError> {
  return ws
    .subscribe(filterFromRealClient(filter), () => Effect.void)
    .pipe(
      Effect.map((handle) => ({
        id: handle.id,
        unsubscribe: handle.unsubscribe,
      })),
      Effect.mapError((cause) => lifecycleError(cause)),
    );
}

function makeNotificationSubscriber(
  ws: MoltZapWsClient,
  notificationsRef: Ref.Ref<ReadonlyArray<ObservedNotification>>,
): RealClientNotificationSubscriber {
  return {
    subscribe: (filter) => subscribeRealClient(ws, filter),
    snapshot: Ref.get(notificationsRef),
  };
}

function callRealClientRpc(
  ws: MoltZapWsClient,
  method: string,
  params: unknown,
): Effect.Effect<ResponseFrame, RealClientRpcError> {
  return Effect.gen(function* () {
    const definition = yield* resolveRpcDefinition(method, params);
    const result = yield* ws
      .sendRpc(definition, params as ParamsOf<typeof definition>)
      .pipe(Effect.mapError(rpcErrorForMethod(method)));
    return definition.encodeResponse(null, result) as ResponseFrame;
  });
}

function makeRpcCaller(ws: MoltZapWsClient): RealClientRpcCaller {
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
 * can invoke. The returned factory creates a fresh `MoltZapWsClient`,
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
      const captureAll = yield* captureAllNotifications(ws, notificationsRef);

      yield* addClientFinalizer(ws, captureAll);
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
