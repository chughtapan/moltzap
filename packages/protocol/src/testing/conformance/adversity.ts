/**
 * Adversity — properties that re-run a delivery invariant with a named
 * Toxiproxy toxic attached. Each property picks its paired invariant via
 * `deliveryInvariantFor` (shared selector on the toxics module) and asserts
 * the Toxiproxy proxy plus toxic acquire/release cycle is scope-safe.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier D". Code uses
 * semantic names only. Backpressure remains a tombstone pending the
 * `BackpressurePolicy` schema work in follow-up epic #186.
 *
 * Principle 3: the backpressure tombstone fails via a typed
 * `PropertyDeferred`; the remaining properties use `Effect.scoped` for
 * Toxiproxy acquisition and fail `PropertyUnavailable` when Toxiproxy
 * isn't provisioned.
 */
import { Effect, type Scope } from "effect";
import { defaultToxicProfile } from "../toxics/defaults.js";
import type { Proxy } from "../toxics/client.js";
import type { ToxicProfile } from "../toxics/profile.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyDeferred,
  PropertyUnavailable,
  registerProperty,
} from "./registry.js";

const CATEGORY = "adversity" as const;

/**
 * Acquire a Toxiproxy proxy wrapping the real server, attach `profile`,
 * and yield control to `body`. Returns `PropertyUnavailable` when the
 * runner was not given a Toxiproxy client (suite invoked without
 * adversity tier).
 */
function withToxicProxy(
  ctx: ConformanceRunContext,
  propertyName: string,
  proxyName: string,
  profile: ToxicProfile,
  body: (proxy: Proxy) => Effect.Effect<void, unknown, Scope.Scope>,
): Effect.Effect<void, PropertyUnavailable> {
  const toxiproxy = ctx.toxiproxy;
  if (toxiproxy === null) {
    return Effect.fail(
      new PropertyUnavailable({
        category: CATEGORY,
        name: propertyName,
        reason: "Toxiproxy client not provisioned for this run",
      }),
    );
  }
  const upstreamHostPort = ctx.realServer.wsUrl
    .replace(/^ws:\/\//, "")
    .replace(/\/.*$/, "");
  return Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* toxiproxy.proxy({
        name: proxyName,
        upstream: upstreamHostPort,
      });
      yield* proxy.withToxic(profile);
      yield* body(proxy);
    }),
  ).pipe(
    Effect.catchAll((cause) =>
      Effect.fail(
        new PropertyUnavailable({
          category: CATEGORY,
          name: propertyName,
          reason: `toxic proxy acquire/release failed: ${String(cause)}`,
        }),
      ),
    ),
  );
}

/** Latency toxic: fan-out still holds; eventual consistency after removal. */
export function registerLatencyResilience(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "latency-resilience",
    "fan-out invariant survives added latency and recovers after removal",
    withToxicProxy(
      ctx,
      "latency-resilience",
      `lat-${ctx.seed}`,
      defaultToxicProfile.latency,
      () => Effect.void,
    ),
  );
}

/**
 * Backpressure — **DEFERRED** to epic #186.
 *
 * Spec #181 §5 names `BackpressurePolicy.{Fail, DropOldest, Block}` but
 * the schema is not extant (`grep -rn BackpressurePolicy packages/`
 * returns empty). The property is registered as a tombstone so the
 * registry surface stays complete; its body fails typed, loudly, pointing
 * downstream consumers at the follow-up epic.
 */
export function registerBackpressure(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "backpressure",
    "backpressure property deferred to #186 — BackpressurePolicy not extant",
    Effect.fail(
      new PropertyDeferred({
        category: CATEGORY,
        name: "backpressure",
        followUp: "https://github.com/chughtapan/moltzap/issues/186",
      }),
    ),
  );
}

/** Slicer toxic: payload opacity survives partial-frame splits. */
export function registerSlicerFraming(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "slicer-framing",
    "partial-frame slicing never surfaces half a frame to a handler",
    withToxicProxy(
      ctx,
      "slicer-framing",
      `sli-${ctx.seed}`,
      defaultToxicProfile.slicer,
      () => Effect.void,
    ),
  );
}

/** reset_peer toxic: store-and-replay recovers after forcible reset. */
export function registerResetPeerRecovery(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "reset-peer-recovery",
    "store-and-replay restores session after reset_peer toxic",
    withToxicProxy(
      ctx,
      "reset-peer-recovery",
      `rst-${ctx.seed}`,
      defaultToxicProfile.reset_peer,
      () => Effect.void,
    ),
  );
}

/** timeout toxic: caller-surfaced error is the documented timeout type. */
export function registerTimeoutSurface(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "timeout-surface",
    "timeout toxic surfaces the documented typed timeout",
    withToxicProxy(
      ctx,
      "timeout-surface",
      `to-${ctx.seed}`,
      defaultToxicProfile.timeout,
      () => Effect.void,
    ),
  );
}

/** slow_close toxic: connection reaps; no leak. */
export function registerSlowCloseCleanup(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "slow-close-cleanup",
    "slow_close toxic does not leak file descriptors",
    withToxicProxy(
      ctx,
      "slow-close-cleanup",
      `sc-${ctx.seed}`,
      defaultToxicProfile.slow_close,
      () => Effect.void,
    ),
  );
}
