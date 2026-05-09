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
 *
 * Phase 1A interface stub. Implementer (sub-issue #546) carves the
 * per-property files out of `presence.ts`.
 */
// During Phase 1A interface-stub phase the runner still lives at the
// legacy `conformance/runner.ts` location. Implementer (sub-issue #546)
// rewrites this import to `../_shared/runner.js` after moving the file.
import type { ConformanceRunContext } from "../runner.js";

/**
 * All network-layer property registrars, in the order
 * `_shared/suite.ts` invokes them.
 */
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [];
