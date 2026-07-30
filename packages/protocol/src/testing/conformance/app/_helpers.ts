/**
 * App-layer helpers shared across the 15 dispatch-admission properties.
 */
import { Effect, type Scope, type Schema } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  type PropertyFailure,
  type PropertyRun,
} from "../_shared/registry.js";
import { makeDispatchTestDriver, type DispatchTestDriver } from "./_driver.js";
import type { messageId } from "@moltzap/protocol/conversation";
import { messageId as makeMessageId } from "../_shared/test-fixtures.js";

/** Provides the dispatch admission category runtime value. */
export const DISPATCH_ADMISSION_CATEGORY = "dispatch-admission";

/** Provides the short lease timeout ms runtime value. */
export const SHORT_LEASE_TIMEOUT_MS = 250;
/** Provides the tiny moderator timeout ms runtime value. */
export const TINY_MODERATOR_TIMEOUT_MS = 200;
/** Provides the ttl observation buffer ms runtime value. */
export const TTL_OBSERVATION_BUFFER_MS = 1_500;
/** Provides the abandon observation buffer ms runtime value. */
export const ABANDON_OBSERVATION_BUFFER_MS = 1_000;
/** Provides the negative observability window ms runtime value. */
export const NEGATIVE_OBSERVABILITY_WINDOW_MS = 750;
/** Provides the forbidden error tag runtime value. */
export const FORBIDDEN_ERROR_TAG = "Forbidden";
// Buffer added to ABANDON_OBSERVATION_BUFFER_MS when polling for the
// finalizer-driven ABANDONED transition: the finalizer runs on a
// fiber-scoped scope-close, so the poll bound must outlast both the
// observation window and the connection-close round-trip.
/** Provides the abandon poll extra ms runtime value. */
export const ABANDON_POLL_EXTRA_MS = 2_000;
// Window for waiting on a synthesized timeout `agent/dispatch/released`. Must
// be greater than `TINY_MODERATOR_TIMEOUT_MS` (the server-side
// moderator-response TTL) by enough margin to absorb scheduling jitter
// in CI.
/** Provides the timeout release wait ms runtime value. */
export const TIMEOUT_RELEASE_WAIT_MS = 3_000;
// Tight window asserting that NO second `agent/dispatch/released` arrives for
// a single lease. Short enough to keep property runtime bounded; long
// enough to catch a duplicate emit race.
/** Provides the no second release window ms runtime value. */
export const NO_SECOND_RELEASE_WINDOW_MS = 250;
// Wall-clock bound for "second ack does not block on first" assertions:
// must be much less than the held HOLD_MS so we detect server-side
// serialization without false-positives under CI scheduling jitter.
/** Provides the fast ack threshold ms runtime value. */
export const FAST_ACK_THRESHOLD_MS = 1_000;
// Margin shaved off `HOLD_MS` when waiting for the FAST release: must be
// long enough to outlive scheduling jitter, short enough to fail before
// the slow release completes.
/** Provides the hold release margin ms runtime value. */
export const HOLD_RELEASE_MARGIN_MS = 500;
// Margin added to `HOLD_MS` when draining the slow release: covers
// fan-out latency and finalizer scheduling.
/** Provides the hold drain buffer ms runtime value. */
export const HOLD_DRAIN_BUFFER_MS = 2_000;

/**
 * Executes the dispatch admission violation operation.
 * @param name Name of the operation.
 * @param reason Value supplied to the operation.
 * @returns The dispatch admission violation result.
 */
export function dispatchAdmissionViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: DISPATCH_ADMISSION_CATEGORY,
    name,
    reason,
  });
}

// Frame-payload narrowings used across the property bodies. The narrow
// surfaces match the dispatch wire schemas.
/** Describes release frame view. */
export interface ReleaseFrameView {
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
}
/** Describes lease id only view. */
export interface LeaseIdOnlyView {
  readonly leaseId: string;
}
/** Describes consumed frame view. */
export interface ConsumedFrameView {
  readonly messageId: string;
  readonly leaseId: string;
}

/**
 * Executes the fresh message id operation.
 * @returns The fresh message id result.
 */
export function freshMessageId(): Schema.Schema.Type<typeof messageId> {
  // UUIDv4 from the runtime; the brand-decoder accepts a well-formed
  // UUID4 string. `crypto.randomUUID` is in Node 18+.
  return makeMessageId(globalThis.crypto.randomUUID());
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checks whether uuid v4.
 * @param s Value supplied to the operation.
 * @returns Whether uuid v4.
 */
export function isUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

/**
 * Run a property body inside a fresh per-property scope; acquires the
 * driver, runs `body`, releases on completion.
 * @param ctx Context for the operation.
 * @param body Serialized response body to decode.
 * @param driverOpts Value supplied to the operation.
 * @returns The with driver result.
 */
export function withDriver(
  ctx: ConformanceRunContext,
  body: (
    driver: DispatchTestDriver,
  ) => Effect.Effect<void, PropertyFailure, Scope.Scope>,
  driverOpts?: Parameters<typeof makeDispatchTestDriver>[1],
): PropertyRun {
  return Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* makeDispatchTestDriver(ctx, driverOpts);
      yield* body(driver);
    }).pipe(Effect.withSpan("withDriver")),
  );
}
