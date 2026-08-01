/**
 * @file Public barrel for transport-layer conformance properties.
 *
 * Transport-layer conformance properties.
 *
 * Lifecycle transport invariants — adversity around latency,
 * connection-reset, timeout, and close.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `TRANSPORT_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerLatencyResilience } from "./adversity-latency-resilience.js";
import { registerResetPeerRecovery } from "./adversity-reset-peer-recovery.js";
import { registerTimeoutSurface } from "./adversity-timeout-surface.js";
import { registerSlowCloseCleanup } from "./adversity-slow-close-cleanup.js";

export {
  registerLatencyResilience,
  registerResetPeerRecovery,
  registerSlowCloseCleanup,
  registerTimeoutSurface,
};

/**
 * All transport-layer property registrars, in the order
 * `_shared/suite.ts` invokes them.
 */
export const TRANSPORT_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerLatencyResilience,
  registerResetPeerRecovery,
  registerTimeoutSurface,
  registerSlowCloseCleanup,
];
