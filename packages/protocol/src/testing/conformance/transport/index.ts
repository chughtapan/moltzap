/**
 * Transport-layer conformance properties.
 *
 * Wire-level invariants — frame schemas, RPC dispatch primitives,
 * adversity (latency / framing / connection-reset / timeout / close).
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `TRANSPORT_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerRequestWellFormedness } from "./request-well-formedness.js";
import { registerNotificationWellFormedness } from "./notification-well-formedness.js";
import { registerRoundTripIdentity } from "./round-trip-identity.js";
import { registerMalformedFrameHandling } from "./malformed-frame-handling.js";
import { registerRpcMapCoverage } from "./rpc-map-coverage.js";
import { registerRequestIdUniqueness } from "./request-id-uniqueness.js";
import { registerCallerControlledAppCallbackTimeout } from "./caller-controlled-app-callback-timeout.js";
import { registerLatencyResilience } from "./adversity-latency-resilience.js";
import { registerBackpressure } from "./adversity-backpressure.js";
import { registerSlicerFraming } from "./adversity-slicer-framing.js";
import { registerResetPeerRecovery } from "./adversity-reset-peer-recovery.js";
import { registerTimeoutSurface } from "./adversity-timeout-surface.js";
import { registerSlowCloseCleanup } from "./adversity-slow-close-cleanup.js";
import { registerSchemaExhaustiveFuzz } from "./schema-exhaustive-fuzz.js";

export {
  registerRequestWellFormedness,
  registerNotificationWellFormedness,
  registerRoundTripIdentity,
  registerMalformedFrameHandling,
  registerRpcMapCoverage,
  registerRequestIdUniqueness,
  registerCallerControlledAppCallbackTimeout,
  registerLatencyResilience,
  registerBackpressure,
  registerSlicerFraming,
  registerResetPeerRecovery,
  registerTimeoutSurface,
  registerSlowCloseCleanup,
  registerSchemaExhaustiveFuzz,
};

/**
 * All transport-layer property registrars, in the order
 * `_shared/suite.ts` invokes them. Order matches the legacy
 * `registerAllProperties` walk for byte-equivalent baseline output:
 * schema-conformance subset (5) → rpc-semantics subset (2) →
 * adversity (6) → boundary subset (1).
 */
export const TRANSPORT_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerRequestWellFormedness,
  registerNotificationWellFormedness,
  registerRoundTripIdentity,
  registerMalformedFrameHandling,
  registerRpcMapCoverage,
  registerRequestIdUniqueness,
  registerCallerControlledAppCallbackTimeout,
  registerLatencyResilience,
  registerBackpressure,
  registerSlicerFraming,
  registerResetPeerRecovery,
  registerTimeoutSurface,
  registerSlowCloseCleanup,
  registerSchemaExhaustiveFuzz,
];
