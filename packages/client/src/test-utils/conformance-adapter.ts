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
 * public API (`connect`, `close`, `sendRpc`, `onEvent`, `onDisconnect`):
 * no private reads, no monkey-patching (Invariant I9 from spec #200).
 */
import { Effect, Ref, Scope } from "effect";
import type { EventFrame, ResponseFrame } from "@moltzap/protocol";
import type {
  RealClientCloseEvent,
  RealClientHandle,
  RealClientEventSubscriber,
  RealClientLifecycleError,
  RealClientRpcCaller,
  RealClientSubscription,
  ObservedEvent,
} from "@moltzap/protocol/testing";
import { MoltZapWsClient } from "../ws-client.js";

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
        onEvent: (frame: EventFrame) => {
          const encoded = new TextEncoder().encode(JSON.stringify(frame));
          const data = frame.data as { __emissionTag?: string } | undefined;
          const tag =
            typeof data?.__emissionTag === "string" ? data.__emissionTag : null;
          const obs: ObservedEvent = {
            emissionTag: tag,
            decoded: frame,
            rawBytes: encoded,
            observedAtMs: Date.now(),
          };
          // #ignore-sloppy-code-next-line[bare-catch]: onEvent is a sync callback boundary; surface ref-update errors to nowhere
          try {
            Effect.runSync(Ref.update(eventsRef, (xs) => [...xs, obs]));
          } catch {
            /* best-effort observation collection */
          }
        },
        onDisconnect: () => {
          // #ignore-sloppy-code-next-line[bare-catch]: onDisconnect is sync; ref update is best-effort
          try {
            Effect.runSync(
              Ref.update(
                closeRef,
                (cur) =>
                  cur ?? {
                    code: 1000,
                    reason: "disconnect",
                    observedAtMs: Date.now(),
                  },
              ),
            );
          } catch {
            /* best-effort */
          }
        },
      });

      // Scope-release finalizer: close the WS client.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Effect.runSync(ws.close());
        }),
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
        _filter,
      ): Effect.Effect<RealClientSubscription, RealClientLifecycleError> =>
        Effect.succeed({
          id: `sub-${Math.random().toString(36).slice(2, 8)}`,
          unsubscribe: Effect.void,
        });

      const snapshot: RealClientEventSubscriber["snapshot"] =
        Ref.get(eventsRef);

      const events: RealClientEventSubscriber = { subscribe, snapshot };

      const call: RealClientRpcCaller["call"] = (
        method: string,
        params: unknown,
      ) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.either(ws.sendRpc(method, params));
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
          // `sendRpc` returns the result payload; wrap into a minimal
          // `ResponseFrame` shape for the suite's consumers.
          const frame: ResponseFrame = {
            jsonrpc: "2.0",
            type: "response",
            id: `local-${Math.random().toString(36).slice(2, 10)}`,
            result: outcome.right,
          };
          // Record the id (best-effort; the real client's internal id is
          // not exposed, so the adapter mints a mirror id for the suite's
          // outbound-id-feed predicate).
          yield* Ref.update(outboundIdsRef, (xs) => [...xs, frame.id]);
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

      const close: Effect.Effect<void, RealClientLifecycleError> = Effect.sync(
        () => {
          Effect.runSync(ws.close());
        },
      );

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
