/**
 * App-layer helpers shared across the 15 dispatch-admission properties.
 *
 * Carved verbatim from `conformance/dispatch-admission.ts@961a5c8`.
 * Body unchanged; import paths shift to the new layer location.
 */
import { Effect, type Scope } from "effect";
import type { Static } from "@sinclair/typebox";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  type PropertyFailure,
  type PropertyRun,
} from "../_shared/registry.js";
import { makeDispatchTestDriver, type DispatchTestDriver } from "./_driver.js";
import type { MessageId } from "../../../task/methods.js";
import { messageId as makeMessageId } from "../_shared/test-fixtures.js";

export const DISPATCH_ADMISSION_CATEGORY = "dispatch-admission" as const;

export const SHORT_LEASE_TIMEOUT_MS = 250;
export const TINY_MODERATOR_TIMEOUT_MS = 200;
export const TTL_OBSERVATION_BUFFER_MS = 1_500;
export const ABANDON_OBSERVATION_BUFFER_MS = 1_000;
export const NEGATIVE_OBSERVABILITY_WINDOW_MS = 750;
export const FORBIDDEN_ERROR_CODE = -32001;
// Buffer added to ABANDON_OBSERVATION_BUFFER_MS when polling for the
// finalizer-driven ABANDONED transition: the finalizer runs on a
// fiber-scoped scope-close, so the poll bound must outlast both the
// observation window and the connection-close round-trip.
export const ABANDON_POLL_EXTRA_MS = 2_000;
// Window for waiting on a synthesized timeout `dispatch/release`. Must
// be greater than `TINY_MODERATOR_TIMEOUT_MS` (the server-side
// moderator-response TTL) by enough margin to absorb scheduling jitter
// in CI.
export const TIMEOUT_RELEASE_WAIT_MS = 3_000;
// Tight window asserting that NO second `dispatch/release` arrives for
// a single lease. Short enough to keep property runtime bounded; long
// enough to catch a duplicate emit race.
export const NO_SECOND_RELEASE_WINDOW_MS = 250;
// Wall-clock bound for "second ack does not block on first" assertions:
// must be much less than the held HOLD_MS so we detect server-side
// serialization without false-positives under CI scheduling jitter.
export const FAST_ACK_THRESHOLD_MS = 1_000;
// Margin shaved off `HOLD_MS` when waiting for the FAST release: must be
// long enough to outlive scheduling jitter, short enough to fail before
// the slow release completes.
export const HOLD_RELEASE_MARGIN_MS = 500;
// Margin added to `HOLD_MS` when draining the slow release: covers
// fan-out latency and finalizer scheduling.
export const HOLD_DRAIN_BUFFER_MS = 2_000;

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
// surfaces match the wire schemas in `protocol/src/app/methods.ts`.
export type ReleaseFrameView = {
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
};
export type LeaseIdOnlyView = { readonly leaseId: string };
export type ConsumedFrameView = {
  readonly messageId: string;
  readonly leaseId: string;
};

export function freshMessageId(): Static<typeof MessageId> {
  // UUIDv4 from the runtime; the brand-decoder accepts a well-formed
  // UUID4 string. `crypto.randomUUID` is in Node 18+.
  return makeMessageId(globalThis.crypto.randomUUID());
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

/**
 * Run a property body inside a fresh per-property scope; acquires the
 * driver, runs `body`, releases on completion.
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
    }),
  );
}
