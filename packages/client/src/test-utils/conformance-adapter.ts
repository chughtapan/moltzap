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
 * Spec #222 atomic migration:
 *   - `outboundIdsRef` is populated from `sendRpcTracked.id` — the real
 *     `rpc-N` identity, not a `local-${random}` mirror (B4).
 *   - `ResponseFrame.type` is forwarded from `tracked.type`, not a
 *     hardcoded `"response"` (V5).
 *   - `closeRef` is populated from `CloseInfo.{code, reason}` passed
 *     into `onDisconnect`, not the hardcoded `{1000, "disconnect"}`
 *     (V7).
 *   - `subscribe` registers a real per-filter handle on the client; the
 *     no-op stub is gone (C4 + subscribe-stub).
 */
import { Effect, Ref, Scope } from "effect";
import type { EventFrame, ResponseFrame } from "@moltzap/protocol";
import type {
  RealClientCloseEvent,
  RealClientEventFilter,
  RealClientHandle,
  RealClientEventSubscriber,
  RealClientLifecycleError,
  RealClientRpcCaller,
  RealClientSubscription,
  ObservedEvent,
} from "@moltzap/protocol/testing";
import { MoltZapWsClient, type CloseInfo } from "../ws-client.js";
import type { SubscriptionFilter } from "../runtime/subscribers.js";

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

type LifecycleError = {
  readonly _tag: "RealClientLifecycleError";
  readonly cause: unknown;
};

function lifecycleError(cause: unknown): LifecycleError {
  // Struct-shaped value rather than a `new RealClientLifecycleError` — the
  // protocol's `runner.ts` defines the class, but this adapter ships in
  // `@moltzap/client` which consumes the protocol package as a leaf (can't
  // cross-import the class without creating a cycle via typings alone). The
  // shape matches 1:1 so callers that discriminate on `_tag` work.
  return { _tag: "RealClientLifecycleError", cause };
}

/**
 * Project a `RealClientEventFilter` (protocol-side shape) onto a
 * `SubscriptionFilter` (client-side shape). One-for-one field mapping
 * — both interfaces share the same three optional fields by design.
 */
function filterFromRealClient(
  filter: RealClientEventFilter,
): SubscriptionFilter {
  return {
    emissionTag: filter.emissionTag,
    conversationId: filter.conversationId,
    eventNamePrefix: filter.eventNamePrefix,
  };
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
      const eventsRef = yield* Ref.make<ReadonlyArray<ObservedEvent>>([]);
      const outboundIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const closeRef = yield* Ref.make<RealClientCloseEvent | null>(null);

      const ws = new MoltZapWsClient({
        serverUrl: args.testServerUrl,
        agentKey: opts.agentKey,
        // V7: real WebSocket close metadata flows through `close.code`
        // / `close.reason`, not the deleted `{1000, "disconnect"}`
        // hardcode. The reader fiber's `extractCloseInfo` derives these
        // from the actual `Exit.Exit<…, Socket.SocketError>`.
        onDisconnect: (close: CloseInfo) => {
          // #ignore-sloppy-code-next-line[bare-catch]: onDisconnect is sync; ref update is best-effort
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
          } catch {
            /* best-effort */
          }
        },
      });

      // C4 + subscribe-stub: register a `{}`-filter subscription that
      // captures every frame into `eventsRef`. The previous top-level
      // `onEvent` callback was deleted — `subscribe({})` is the
      // replacement. Pre-`connect()` registration is supported.
      const captureAll = yield* ws
        .subscribe({}, (frame: EventFrame) =>
          Effect.sync(() => {
            const encoded = new TextEncoder().encode(JSON.stringify(frame));
            const data = frame.data as { __emissionTag?: string } | undefined;
            const tag =
              typeof data?.__emissionTag === "string"
                ? data.__emissionTag
                : null;
            const obs: ObservedEvent = {
              emissionTag: tag,
              decoded: frame,
              rawBytes: encoded,
              observedAtMs: Date.now(),
            };
            // #ignore-sloppy-code-next-line[bare-catch]: ref-update best-effort
            try {
              Effect.runSync(Ref.update(eventsRef, (xs) => [...xs, obs]));
            } catch {
              /* best-effort observation collection */
            }
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => lifecycleError(cause) as RealClientLifecycleError,
          ),
        );

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
        Effect.gen(function* () {
          const outcome = yield* Effect.either(ws.connect());
          if (outcome._tag === "Right") {
            yield* Ref.set(readyDeferred, "resolved");
          } else {
            yield* Ref.set(readyDeferred, { cause: outcome.left });
          }
        }),
      );

      const ready: Effect.Effect<void, RealClientLifecycleError> = Effect.gen(
        function* () {
          // Internal handshake budget is generous — the outer
          // `_fixtures.acquireFixture` wraps the whole `ready` with a
          // suite-level timeout that defines the actual property budget.
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const state = yield* Ref.get(readyDeferred);
            if (state === "resolved") return;
            if (typeof state === "object") {
              return yield* Effect.fail(
                lifecycleError(state.cause) as RealClientLifecycleError,
              );
            }
            yield* Effect.sleep("25 millis");
          }
          return yield* Effect.fail(
            lifecycleError(
              new Error("connect timeout"),
            ) as RealClientLifecycleError,
          );
        },
      );

      const subscribe: RealClientEventSubscriber["subscribe"] = (
        filter,
      ): Effect.Effect<RealClientSubscription, RealClientLifecycleError> =>
        ws
          .subscribe(filterFromRealClient(filter), () => Effect.void)
          .pipe(
            Effect.map((handle) => ({
              id: handle.id,
              unsubscribe: handle.unsubscribe,
            })),
            Effect.mapError(
              (cause) => lifecycleError(cause) as RealClientLifecycleError,
            ),
          );

      const snapshot: RealClientEventSubscriber["snapshot"] =
        Ref.get(eventsRef);

      const events: RealClientEventSubscriber = { subscribe, snapshot };

      const call: RealClientRpcCaller["call"] = (
        method: string,
        params: unknown,
      ) =>
        Effect.gen(function* () {
          // B4 + V5: `sendRpcTracked` returns the real outbound id and
          // the response envelope `type`. The adapter forwards both
          // straight through — no mirror id, no hardcoded `"response"`.
          const outcome = yield* Effect.either(
            ws.sendRpcTracked(method, params),
          );
          if (outcome._tag === "Left") {
            const tag = outcome.left._tag;
            const kind =
              tag === "RpcTimeoutError"
                ? ("timeout" as const)
                : tag === "RpcServerError"
                  ? ("server-error" as const)
                  : tag === "NotConnectedError"
                    ? ("disconnected" as const)
                    : ("malformed-response" as const);
            return yield* Effect.fail({
              _tag: "RealClientRpcError" as const,
              kind,
              method,
              documentedErrorTag: tag,
              cause: outcome.left,
            });
          }
          const tracked = outcome.right;
          // Record the real id (Invariant 3 from spec #222: same id
          // minted at the `rpc-${++counter}` site, surfaced as-is).
          yield* Ref.update(outboundIdsRef, (xs) => [...xs, tracked.id]);
          const frame: ResponseFrame = {
            jsonrpc: "2.0",
            type: tracked.type,
            id: tracked.id,
            result: tracked.result,
          };
          return frame;
        });

      const rpcCaller: RealClientRpcCaller = {
        call,
        outboundIdFeed: Ref.get(outboundIdsRef),
      };

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
        events,
        call: rpcCaller,
        closeSignal,
        close,
      } satisfies RealClientHandle;
    });
}
