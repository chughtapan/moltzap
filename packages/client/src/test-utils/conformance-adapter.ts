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

function rpcError(
  cause: NotConnectedError | RpcServerError | RpcTimeoutError,
  method: string,
): RealClientRpcError {
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
    documentedErrorTag: null,
    kind: "malformed-response",
    method,
  }) as RealClientRpcError;
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

      const ws = new MoltZapWsClient({
        serverUrl: args.testServerUrl,
        agentKey: opts.agentKey,
        // V7: real WebSocket close metadata flows through `close.code`
        // / `close.reason`, not the deleted `{1000, "disconnect"}`
        // hardcode. The reader fiber's `extractCloseInfo` derives these
        // from the actual `Exit.Exit<…, Socket.SocketError>`.
        onDisconnect: (close: CloseInfo) => {
          try {
            Effect.runSync(
              Ref.update(
                closeRef,
                (cur) =>
                  cur ?? {
                    code: close.code,
                    reason: close.reason,
                    observedAtMs: Date.now(),
                  },
              ),
            );
          } catch (closeErr) {
            logConformanceAdapterWarning(
              "failed to record conformance close event",
              closeErr,
            );
          }
        },
      });

      // C4 + subscribe-stub: register a `{}`-filter subscription that
      // captures every frame into `notificationsRef`. The previous top-level
      // `onNotification` callback was deleted — `subscribe({})` is the
      // replacement. Pre-`connect()` registration is supported.
      const captureAll = yield* ws
        .subscribe({}, (frame: NotificationFrame) =>
          Effect.sync(() => {
            // Strip `definition` (added by `decodeNotification` post-Phase-12)
            // before re-encoding so `rawBytes` matches the wire form the
            // TestServer originally emitted. Conformance correlation in
            // `lookupTagForRawBytes` keys on the wire form.
            const wireFrame: NotificationFrame = {
              jsonrpc: frame.jsonrpc,
              method: frame.method,
              ...(frame.params !== undefined ? { params: frame.params } : {}),
            };
            const encoded = new TextEncoder().encode(JSON.stringify(wireFrame));
            const obs: ObservedNotification = {
              emissionTag: null,
              decoded: wireFrame,
              rawBytes: encoded,
              observedAtMs: Date.now(),
            };
            try {
              Effect.runSync(
                Ref.update(notificationsRef, (xs) => [...xs, obs]),
              );
            } catch (recordErr) {
              logConformanceAdapterWarning(
                "failed to record conformance observation",
                recordErr,
              );
            }
          }),
        )
        .pipe(Effect.mapError((cause) => lifecycleError(cause)));

      // Scope-release finalizer: drop the capture subscription and
      // close the WS client. `ws.close()` is Effect-native post-#234,
      // so the finalizer chains them with `Effect.zipRight` and no
      // `Effect.sync(runSync(...))` bridge.
      yield* Effect.addFinalizer(() =>
        captureAll.unsubscribe.pipe(Effect.zipRight(ws.close())),
      );

      // Kick off the connect; tracked via the `ready` Effect below.
      const readyDeferred = yield* Ref.make<
        "pending" | "resolved" | { readonly cause: unknown }
      >("pending");
      yield* Effect.forkScoped(
        ws.connect().pipe(
          Effect.either,
          Effect.flatMap(
            Either.match({
              onLeft: (cause) => Ref.set(readyDeferred, { cause }),
              onRight: () => Ref.set(readyDeferred, "resolved"),
            }),
          ),
        ),
      );

      const ready: Effect.Effect<void, RealClientLifecycleError> = Effect.gen(
        function* () {
          // Internal handshake budget is generous — the outer
          // `_fixtures.acquireFixture` wraps the whole `ready` with a
          // suite-level timeout that defines the actual property budget.
          const deadline = Date.now() + CONNECT_READY_TIMEOUT_MS;
          while (Date.now() < deadline) {
            const state = yield* Ref.get(readyDeferred);
            if (state === "resolved") return;
            if (typeof state === "object") {
              return yield* Effect.fail(lifecycleError(state.cause));
            }
            yield* Effect.sleep("25 millis");
          }
          return yield* Effect.fail(lifecycleError("connect timeout"));
        },
      );

      const subscribe: RealClientNotificationSubscriber["subscribe"] = (
        filter,
      ): Effect.Effect<RealClientSubscription, RealClientLifecycleError> =>
        ws
          .subscribe(filterFromRealClient(filter), () => Effect.void)
          .pipe(
            Effect.map((handle) => ({
              id: handle.id,
              unsubscribe: handle.unsubscribe,
            })),
            Effect.mapError((cause) => lifecycleError(cause)),
          );

      const snapshot: RealClientNotificationSubscriber["snapshot"] =
        Ref.get(notificationsRef);

      const notifications: RealClientNotificationSubscriber = {
        subscribe,
        snapshot,
      };

      const call: RealClientRpcCaller["call"] = (
        method: string,
        params: unknown,
      ) =>
        Effect.gen(function* () {
          // The conformance suite passes string method names; resolve to
          // the protocol descriptor by name. Per-def `validateParams` is
          // checked inside `ws.sendRpc` via wire validation.
          const definition = rpcMethods.find(
            (d): d is AnyRpcDefinition => d.name === method,
          );
          if (definition === undefined || !definition.validateParams(params)) {
            return yield* Effect.fail(
              new RealClientRpcFailure({
                cause: { method, params },
                documentedErrorTag: null,
                kind: "malformed-response",
                method,
              }) as RealClientRpcError,
            );
          }
          const result = yield* ws
            .sendRpc(definition, params as ParamsOf<typeof definition>)
            .pipe(Effect.mapError((cause) => rpcError(cause, method)));
          return definition.encodeResponse(null, result) as ResponseFrame;
        });

      const rpcCaller: RealClientRpcCaller = { call };

      const closeSignal: Effect.Effect<RealClientCloseEvent> = Effect.gen(
        function* () {
          while (true) {
            const cur = yield* Ref.get(closeRef);
            if (cur !== null) return cur;
            yield* Effect.sleep("25 millis");
          }
        },
      );

      const close: Effect.Effect<void, RealClientLifecycleError> = ws.close();

      return {
        agentId: opts.agentId,
        ready,
        notifications,
        call: rpcCaller,
        closeSignal,
        close,
      } satisfies RealClientHandle;
    }).pipe(Effect.withSpan("createMoltZapRealClientFactory"));
}
