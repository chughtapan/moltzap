/**
 * Transport-layer conformance properties.
 *
 * Wire-level invariants — frame schemas, RPC dispatch primitives,
 * adversity (latency / framing / connection-reset / timeout / close).
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `TRANSPORT_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 *
 * Phase 1A interface stub. Implementer (sub-issue #546) carves the
 * per-property files out of the legacy monoliths
 * (`adversity.ts`, `schema-conformance.ts`, `rpc-semantics.ts`,
 * `boundary.ts`) and wires the named exports below.
 */
// During Phase 1A interface-stub phase the runner still lives at the
// legacy `conformance/runner.ts` location. Implementer (sub-issue #546)
// rewrites this import to `../_shared/runner.js` after moving the file.
import type { ConformanceRunContext } from "../runner.js";

/**
 * All transport-layer property registrars, in the order
 * `_shared/suite.ts` invokes them. Order matches the legacy
 * `registerAllProperties` walk for byte-equivalent baseline output.
 */
export const TRANSPORT_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [];

// Implementer wires the per-property re-exports here, e.g.:
//
//   export { registerRequestWellFormedness } from "./request-well-formedness.js";
//   export { registerNotificationWellFormedness } from "./notification-well-formedness.js";
//   ...
//
// And populates TRANSPORT_PROPERTIES with the same set of registrars.
