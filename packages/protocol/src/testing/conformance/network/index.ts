/**
 * @file Public barrel for network-layer conformance properties.
 *
 * Network-layer conformance properties.
 *
 * Connection / presence / subscription invariants — connect lifecycle,
 * server-derived presence (agent/app subscribe fan-out + presence-changed
 * notifications), reconnect semantics, same-state collapse. Presence is
 * server-derived from `LeaseRegistry` lifecycle plus WS connect/disconnect;
 * `PresenceService` implements `LeaseTransitionObserver` and broadcasts
 * presence-changed notifications to subscribers. There is no client-driven
 * `presence/update` RPC.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `NETWORK_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerConnectBroadcast } from "./presence-connect-broadcast.js";
import { registerDisconnectBroadcast } from "./presence-disconnect-broadcast.js";
import { registerReconnectStorm } from "./presence-reconnect-storm.js";
import { registerMultiSubscriberFanOut } from "./presence-multi-subscriber-fan-out.js";
import { registerSubscribeAfterConnect } from "./presence-subscribe-after-connect.js";

export {
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerReconnectStorm,
  registerMultiSubscriberFanOut,
  registerSubscribeAfterConnect,
};

/**
 * All network-layer property registrars, in suite walk order.
 */
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerReconnectStorm,
  registerMultiSubscriberFanOut,
  registerSubscribeAfterConnect,
];
