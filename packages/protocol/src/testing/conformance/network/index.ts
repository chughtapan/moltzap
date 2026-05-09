/**
 * Network-layer conformance properties.
 *
 * Connection / presence / subscription invariants — `Connect` lifecycle,
 * `PresenceUpdate` broadcast, `PresenceSubscribe` fan-out, reconnect
 * semantics, same-state collapse.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `NETWORK_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerConnectBroadcast } from "./presence-connect-broadcast.js";
import { registerDisconnectBroadcast } from "./presence-disconnect-broadcast.js";
import { registerReconnectStorm } from "./presence-reconnect-storm.js";
import { registerSameStateNoDoubleFire } from "./presence-same-state-no-double-fire.js";
import { registerMultiSubscriberFanOut } from "./presence-multi-subscriber-fan-out.js";
import { registerSubscribeAfterConnect } from "./presence-subscribe-after-connect.js";

export {
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerReconnectStorm,
  registerSameStateNoDoubleFire,
  registerMultiSubscriberFanOut,
  registerSubscribeAfterConnect,
};

/**
 * All network-layer property registrars in legacy walk order
 * (mirroring legacy `presence.ts` registration sequence).
 */
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerReconnectStorm,
  registerSameStateNoDoubleFire,
  registerMultiSubscriberFanOut,
  registerSubscribeAfterConnect,
];
