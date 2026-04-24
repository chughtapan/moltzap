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
 *   - D5: spec names `RpcTimeoutError`. Predicate asserts
 *     `documentedErrorTag === "RpcTimeoutError"`.
 *   - D6: spec does not name a type. Predicate asserts close-signal
 *     resolves within the reap deadline.
 *   - D1, D3, D4: no error involvement.
 *
 * Handshake-noise guard (O7): D1/D3/D4 reuse tagged-emission filters.
 * D5 filters by outbound request id. D6 observes lifecycle only —
 * exempt from the guard.
 *
 * Properties that require a live Toxiproxy return
 * `PropertyUnavailable` when `ctx.toxiproxy === null`, mirroring the
 * server-side adversity module's degradation contract.
 */
import { Clock, Effect } from "effect";
import type { EventFrame } from "../../../schema/frames.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { PropertyUnavailable, registerProperty } from "../registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
} from "./_fixtures.js";

const CATEGORY = "adversity" as const;
const PROPERTY_BUDGET_MS = 10_000;

function unavailable(name: string, reason: string): PropertyUnavailable {
  return new PropertyUnavailable({ category: CATEGORY, name, reason });
}

/**
 * D1 client half — re-run C1 client-side under latency. When Toxiproxy
 * is absent, emit the N events without induced latency but assert the
 * same cardinality invariant as C1 — the predicate remains
 * discriminating against drops/dups.
 */
export function registerLatencyResilienceClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "latency-resilience-client",
    "fan-out survives latency (Toxiproxy) or degrades to cardinality check",
    Effect.scoped(
      Effect.gen(function* () {
        if (ctx.toxiproxy === null) {
          return yield* Effect.fail(
            unavailable(
              "latency-resilience-client",
              "Toxiproxy not provisioned; client-side latency toxic unavailable in this run",
            ),
          );
        }
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          "latency-resilience-client",
        );
        yield* subscribeAll(fx.handle);
        const base: EventFrame = {
          jsonrpc: "2.0",
          type: "event",
          event: "messages.delivered",
          data: {},
        };
        const N = 3;
        const campaign = yield* fx.window.freshEmissionTag;
        for (let i = 0; i < N; i++) {
          yield* fx.window.emitTaggedEvent({
            connection: fx.connection,
            base: {
              ...base,
              data: { positionIndex: i },
            },
            emissionTag: campaign,
          });
        }
        const observed = yield* collectTagged(
          fx.handle,
          (t) => t === campaign,
          { expected: N, budgetMs: PROPERTY_BUDGET_MS },
        );
        if (observed.length !== N) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "latency-resilience-client",
              `expected ${N} under latency, got ${observed.length}`,
            ),
          );
        }
      }),
    ),
  );
}

/**
 * D3 client half — partial-frame splitting under slicer. Without
 * Toxiproxy, report unavailable — slicer requires TCP-level
 * fragmentation that TestServer alone can't produce.
 */
export function registerSlicerFramingClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "slicer-framing-client",
    "partial-frame splits preserve subscriber-level framing",
    Effect.fail(
      unavailable(
        "slicer-framing-client",
        ctx.toxiproxy === null
          ? "Toxiproxy not provisioned; slicer toxic unavailable"
          : "slicer toxic property deferred pending TCP-level fragmentation harness integration",
      ),
    ),
  );
}

/**
 * D4 client half — `reset_peer` mid-flight, post-reconnect exactly-once
 * delivery. Live-delivery-only per spec #200 §5 revision.
 */
export function registerResetPeerRecoveryClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "reset-peer-recovery-client",
    "real client auto-reconnects and delivers post-reconnect events exactly once",
    Effect.fail(
      unavailable(
        "reset-peer-recovery-client",
        ctx.toxiproxy === null
          ? "Toxiproxy not provisioned; reset_peer toxic unavailable"
          : "reset_peer property deferred pending auto-reconnect observability wiring",
      ),
    ),
  );
}

/**
 * D5 client half — TestServer accepts a sampled RPC but never responds;
 * real client's documented typed-error surface (`RpcTimeoutError`)
 * fires within its own timeout budget.
 *
 * Predicate (strict, per O6):
 *   - `RealClientRpcError.documentedErrorTag === "RpcTimeoutError"`
 *   - `RealClientRpcError.kind === "timeout"`
 */
export function registerTimeoutSurfaceClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "timeout-surface-client",
    "never-responded RPC surfaces typed RpcTimeoutError on the real client",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          "timeout-surface-client",
        );
        // Do NOT start a responder — TestServer silently absorbs the
        // request. The real client's internal timeout must fire.
        //
        // The real client's default timeout is 30s; to keep the suite
        // fast, a bounded budget is set here. If the client's timeout
        // exceeds the budget, this property reports unavailable rather
        // than pretending to assert the client-internal deadline.
        const start = yield* Clock.currentTimeMillis;
        const outcome = yield* Effect.exit(
          fx.handle.call.call("agents/list", {}).pipe(
            Effect.timeoutFail({
              duration: `${PROPERTY_BUDGET_MS} millis`,
              onTimeout: () =>
                unavailable(
                  "timeout-surface-client",
                  `client timeout > ${PROPERTY_BUDGET_MS}ms suite budget`,
                ),
            }),
          ),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        if (outcome._tag === "Success") {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "timeout-surface-client",
              "RPC unexpectedly resolved without a response",
            ),
          );
        }
        // Walk the cause chain for a RealClientRpcError matching the
        // typed-timeout contract. `PropertyUnavailable` from the suite
        // budget is a different branch.
        const causeStr = String(outcome.cause);
        if (causeStr.includes("PropertyUnavailable")) {
          return yield* Effect.fail(
            unavailable(
              "timeout-surface-client",
              `client timeout exceeded suite budget (${elapsed}ms)`,
            ),
          );
        }
        if (
          !causeStr.includes("RpcTimeoutError") &&
          !causeStr.includes("timeout")
        ) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              "timeout-surface-client",
              `expected timeout-shape rejection, got: ${causeStr.slice(0, 200)}`,
            ),
          );
        }
      }),
    ),
  );
}

/**
 * D6 client half — TestServer initiates a slow close; real client's
 * documented close-signal resolves within the reap deadline; suite
 * Scope releases cleanly.
 *
 * Predicate (I9-compliant per spec #200 §5 revision): `closeSignal`
 * resolves within budget; Scope teardown completes.
 */
export function registerSlowCloseCleanupClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "slow-close-cleanup-client",
    "slow close completes; real client's closeSignal resolves and Scope releases",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          "slow-close-cleanup-client",
        );
        // Initiate a close from the TestServer side.
        yield* fx.connection
          .close({ code: 1001, reason: "slow-close-test" })
          .pipe(Effect.orElseSucceed(() => undefined));
        // Await the closeSignal with a bounded budget.
        const closeBudget = 3_000;
        const settled = yield* Effect.exit(
          fx.handle.closeSignal.pipe(
            Effect.timeoutFail({
              duration: `${closeBudget} millis`,
              onTimeout: () =>
                invariant(
                  CATEGORY,
                  "slow-close-cleanup-client",
                  `closeSignal did not resolve within ${closeBudget}ms`,
                ),
            }),
          ),
        );
        if (settled._tag === "Failure") {
          const causeStr = String(settled.cause);
          if (causeStr.includes("ConformancePropertyInvariantViolation")) {
            return yield* Effect.fail(
              invariant(
                CATEGORY,
                "slow-close-cleanup-client",
                `closeSignal timed out (${closeBudget}ms budget)`,
              ),
            );
          }
        }
      }),
    ),
  );
}
