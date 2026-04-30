/**
 * Default `awaitAgentReady` implementation for in-process consumers whose
 * `ConnectionManager` is reachable synchronously. Polls every 500 ms.
 *
 * Out-of-process consumers (e.g., zapbot's orchestrator over a remote
 * moltzap-server) implement `awaitAgentReady` directly without this helper
 * — see the `@example` block on `awaitAgentReadyByPolling` for the WS-presence
 * sketch.
 */
import { Effect, pipe } from "effect";
import type { ReadyOutcome } from "./runtime.js";

interface ConnectionState {
  readonly auth: unknown | null;
}

/**
 * Structural subset of `@moltzap/server-core`'s `ConnectionManager` that the
 * polling helper actually needs. Typically vended by a `RuntimeServerHandle`
 * implementation; see `@moltzap/server-core`'s test-utils `startCoreTestServer`
 * for the in-process construction pattern that wires `coreApp.connections`
 * directly into the helper.
 *
 * Out-of-process consumers do NOT use this interface — they implement
 * `RuntimeServerHandle.awaitAgentReady` directly per the `@example` block on
 * `awaitAgentReadyByPolling`.
 */
interface PollingConnections {
  getByAgent(agentId: string): ReadonlyArray<ConnectionState>;
}

/**
 * Polls `connections.getByAgent(agentId)` every `pollIntervalMs` until at
 * least one connection has authenticated, then resolves to `Ready`. Resolves
 * to `Timeout` after `timeoutMs` if no authenticated connection ever appears.
 *
 * `ProcessExited` is intentionally NOT produced here: the helper only sees
 * the server's `ConnectionManager`, never the agent's owning subprocess. A
 * caller that wants exit-before-ready surfaced should compose this helper
 * with its own exit detector (e.g., via `Effect.race`) — that is what the
 * runtime adapters do.
 *
 * Out-of-process implementations MAY emit `ProcessExited` if the server has
 * a way to detect process termination (e.g., heartbeat absence on the
 * WebSocket connection, or an explicit `process-exited` event from a
 * presence channel). Implementations that cannot detect process exit should
 * let the presence subscription remain pending; `Timeout` will fire after
 * `timeoutMs` and the caller can investigate via the runtime adapter's
 * `getLogs(0)`.
 *
 * @example
 * Out-of-process consumer (zapbot orchestrator) replaces this helper with a
 * WebSocket presence subscription against a standalone moltzap-server.
 *
 * ```ts
 * // Sketch — replace `WSClientLike` with your real client type. The
 * // structural shape below is the minimum the example uses.
 * interface WSClientLike {
 *   subscribePresence(
 *     agentId: string,
 *     onEvent: (event: {
 *       kind: "auth-success" | "auth-failure" | "process-exited";
 *     }) => void,
 *   ): { unsubscribe: () => void };
 * }
 *
 * function awaitAgentReadyOverPresenceWS(
 *   wsClient: WSClientLike,
 *   agentId: string,
 *   timeoutMs: number,
 * ): Effect.Effect<ReadyOutcome, never, never> {
 *   return Effect.async<ReadyOutcome, never, never>((resume) => {
 *     // The returned cleanup is invoked on Effect interruption (and after
 *     // the first `resume`); it must unsubscribe + clear the timer to
 *     // prevent resource leaks when the caller cancels the wait.
 *     let handle: { unsubscribe: () => void } | null = null;
 *     try {
 *       handle = wsClient.subscribePresence(agentId, (event) => {
 *         if (event.kind === "auth-success") {
 *           resume(Effect.succeed({ _tag: "Ready" }));
 *         }
 *         // `process-exited` and `auth-failure` fall through to the
 *         // timeout path; tighten this branch if your server emits a
 *         // structured exit event you can map to `ProcessExited`.
 *       });
 *     } catch (cause) {
 *       // Subscribe failure: log the cause and surface as Timeout — the
 *       // contract is "never became ready," so a sync subscribe error is
 *       // observably equivalent to no presence event ever arriving.
 *       console.warn("[awaitAgentReady] subscribePresence failed", { cause });
 *       resume(Effect.succeed({ _tag: "Timeout", timeoutMs }));
 *     }
 *     const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
 *       resume(Effect.succeed({ _tag: "Timeout", timeoutMs }));
 *     }, timeoutMs);
 *     return Effect.sync(() => {
 *       handle?.unsubscribe();
 *       clearTimeout(timer);
 *     });
 *   });
 * }
 * ```
 */
export function awaitAgentReadyByPolling(
  connections: PollingConnections,
  agentId: string,
  timeoutMs: number,
  pollIntervalMs: number = 500,
): Effect.Effect<ReadyOutcome, never, never> {
  const tick = Effect.sync(() => {
    const conns = connections.getByAgent(agentId);
    return conns.length > 0 && conns[0]!.auth !== null;
  });
  const pollLoop = pipe(
    tick,
    Effect.flatMap((ready) =>
      Effect.iterate(ready, {
        while: (s) => !s,
        body: () =>
          Effect.sleep(`${pollIntervalMs} millis`).pipe(Effect.zipRight(tick)),
      }),
    ),
    Effect.as<ReadyOutcome>({ _tag: "Ready" as const }),
  );
  return pipe(
    pollLoop,
    Effect.timeoutTo({
      duration: `${timeoutMs} millis`,
      onSuccess: (outcome): ReadyOutcome => outcome,
      onTimeout: (): ReadyOutcome => ({ _tag: "Timeout" as const, timeoutMs }),
    }),
  );
}
