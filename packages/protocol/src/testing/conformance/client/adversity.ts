/**
 * Client-side adversity properties.
 *
 * Covers spec-amendment #200 §5 (all client halves of both-sides):
 *   D1 — adversity-latency
 *   D3 — adversity-slicer
 *   D4 — adversity-reset-peer
 *   D5 — adversity-timeout
 *   D6 — adversity-slow-close
 *
 * D2 (backpressure) tombstoned to #186 (same as server side).
 *
 * Typed-error precision (O6 resolution):
 *   - D1: no error involvement — eventual consistency predicate.
 *   - D3: no error involvement — partial-frame-absorption predicate.
 *   - D4: no error involvement — auto-reconnect + post-reconnect
 *     delivery-exactly-once predicate.
 *   - D5: spec names `RpcTimeoutError` (from
 *     `packages/client/src/runtime/errors.ts`). Predicate asserts
 *     EXACT match: real client's promise rejects with
 *     `documentedErrorTag === "RpcTimeoutError"`. A generic error or
 *     untyped disconnect fails.
 *   - D6: spec does not name a type. Predicate asserts
 *     ANY-DOCUMENTED-CLOSE-PATH: `closeSignal` resolves within the
 *     reap deadline AND the suite-owned Scope closes without dangling
 *     fibers (observable via `Scope` release's Exit tag).
 *
 * Handshake-noise guard (O7): all properties that observe frames
 * (D1 reuses C1, D3 reuses A4, D4 reuses C1-post-reconnect) use
 * `emissionTag` filtering. D5 filters by request id (B4 shape). D6
 * does not observe frames — exempt from the guard.
 */
import type { ClientConformanceRunContext } from "./runner.js";

/**
 * D1 client half — re-run C1 client-side under Toxiproxy `latency`
 * toxic. Eventual consistency: after toxic removed + drain window,
 * `observedByCampaign.length === N`.
 *
 * Predicate: identical to C1 client-side but deadline shifted to
 * cover the latency + drain.
 */
export function registerLatencyResilienceClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * D3 client half — re-run A4 client half under Toxiproxy `slicer`.
 * TestServer emits a valid tagged frame; `slicer` splits it into
 * multiple TCP fragments.
 *
 * Predicate (conjunction):
 *   - no subscriber callback fires on a partial frame (no tagged
 *     observation during the slice window)
 *   - the reassembled frame surfaces exactly once on the subscriber
 *   - liveness: a subsequent tagged frame surfaces within deadline
 *
 * Discriminates: a client whose framing layer invokes the subscriber
 * per-TCP-chunk (instead of per-frame) fails.
 */
export function registerSlicerFramingClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * D4 client half — re-run C1 client-side under Toxiproxy
 * `reset_peer`, scoped to **live delivery only** (per spec #200 §5
 * clarification: missed-event replay across the disconnect window is
 * out of scope, deferred to #186 alongside C2).
 *
 * Predicate (conjunction):
 *   - real client auto-reconnects (all three consumers ship this
 *     today — `packages/client/src/ws-client.ts` reconnect logic;
 *     channel packages inherit it)
 *   - events emitted by TestServer **after** the reconnect completes
 *     arrive on the subscriber stream exactly once
 *   - no duplicates during the reconnect transition (a frame in-
 *     flight at reset becomes a drop, not a dup)
 *
 * Reconnect completion is observed via `RealClientHandle.ready` re-
 * resolving (or equivalent documented signal per-consumer); the
 * property waits on it before emitting the post-reconnect batch.
 */
export function registerResetPeerRecoveryClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * D5 client half — TestServer accepts the real client's sampled RPC
 * request but never emits a response. Real client's
 * `call(method, params)` promise rejects with exactly-typed
 * `RpcTimeoutError` (O6: spec names the type).
 *
 * Predicate (strict conjunction):
 *   - rejection observed within `timeoutMs + slack`
 *   - `RealClientRpcError.documentedErrorTag === "RpcTimeoutError"`
 *   - `RealClientRpcError.kind === "timeout"`
 *
 * Discriminates: a client that rejects with `NotConnectedError` when
 * the socket is actually fine fails. A client that rejects with a
 * generic `Error` fails. A client that never rejects fails.
 */
export function registerTimeoutSurfaceClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * D6 client half — TestServer initiates a slow close (`TCP FIN`
 * without prompt FD release). Real client's documented close /
 * lifecycle signal (`RealClientHandle.closeSignal`) resolves within
 * the reap deadline; suite-owned Scope release completes without
 * dangling fibers or hanging promises.
 *
 * Predicate (conjunction — I9-compliant per spec #200 §5 revision):
 *   - `closeSignal` resolves within deadline (documented public
 *     surface, not FD inspection)
 *   - suite's outer Scope release `Exit` is Success (no dangling
 *     fibers)
 *
 * Discriminates: a client whose close promise never resolves (blocks
 * Scope teardown) fails. FD / process-handle leaks are NOT the
 * observation surface — Scope cleanliness proves release.
 *
 * Exempt from the O7 handshake-noise guard (observes lifecycle,
 * not frames).
 */
export function registerSlowCloseCleanupClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}
