/**
 * @file Public barrel for network-layer conformance properties.
 *
 * Network-layer conformance properties.
 *
 * Connection / presence / subscription invariants. Presence is server-derived
 * from `LeaseRegistry` lifecycle plus WS connect/disconnect; `presence/subscribe`
 * returns the current status snapshot. There is no client-driven
 * `presence/update` RPC.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `NETWORK_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerSubscribeAfterConnect } from "./presence-subscribe-after-connect.js";

export { registerSubscribeAfterConnect };

/**
 * All network-layer property registrars, in suite walk order.
 */
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [registerSubscribeAfterConnect];
