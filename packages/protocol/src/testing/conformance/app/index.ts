/**
 * App-layer conformance properties.
 *
 * Dispatch / lease / app-callback invariants — the 15
 * `dispatch-admission` properties (request / authorize / release /
 * dispatches-consumed / dispatches-expired / dispatches-get / slow-first
 * / same-conv-concurrent / release-for-one-lease) plus app-disconnect
 * fail-policy, hook-gated delivery (tombstoned), multi-app FIFO
 * (tombstoned), spurious app-callback frame handling (tombstoned), and
 * idempotence.
 *
 * Each `register*` lives in its own file. The per-`dispatch-admission`
 * properties draw on the cross-impl driver in `app/_driver.ts` (carved
 * from legacy `conformance/test-server-driver.ts`).
 *
 * Phase 1A interface stub. Implementer (sub-issue #546) carves the
 * per-property files out of `dispatch-admission.ts`, `delivery.ts`,
 * `boundary.ts`, and `rpc-semantics.ts`.
 */
// During Phase 1A interface-stub phase the runner still lives at the
// legacy `conformance/runner.ts` location. Implementer (sub-issue #546)
// rewrites this import to `../_shared/runner.js` after moving the file.
import type { ConformanceRunContext } from "../runner.js";

/**
 * All app-layer property registrars, in the order
 * `_shared/suite.ts` invokes them.
 */
export const APP_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [];
