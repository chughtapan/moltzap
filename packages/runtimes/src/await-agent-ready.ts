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
 * @example
 * Out-of-process consumer (zapbot orchestrator) replaces this helper with a
 * WebSocket presence subscription against a standalone moltzap-server:
 *
 * ```ts
 * function awaitAgentReadyOverPresenceWS(
 *   wsClient: MoltZapWsClient,
 *   agentId: string,
 *   timeoutMs: number,
 * ): Effect.Effect<ReadyOutcome, never, never> {
 *   return Effect.async<ReadyOutcome, never, never>((resume) => {
 *     const handle = wsClient.subscribePresence(agentId, (event) => {
 *       if (event.kind === "auth-success") {
 *         resume(Effect.succeed({ _tag: "Ready" }));
 *       }
 *     });
 *     const timer = setTimeout(() => {
 *       resume(Effect.succeed({ _tag: "Timeout", timeoutMs }));
 *     }, timeoutMs);
 *     return Effect.sync(() => {
 *       handle.unsubscribe();
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
