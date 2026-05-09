/**
 * Task-layer conformance properties.
 *
 * Task / conversation / message invariants — fan-out cardinality,
 * store-and-replay, payload opacity, task-boundary isolation,
 * conversation lifecycle, archive lifecycle, model equivalence,
 * task-close lifecycle.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `TASK_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 *
 * Phase 1A interface stub. Implementer (sub-issue #546) carves the
 * per-property files out of `delivery.ts` and `rpc-semantics.ts`.
 */
// During Phase 1A interface-stub phase the runner still lives at the
// legacy `conformance/runner.ts` location. Implementer (sub-issue #546)
// rewrites this import to `../_shared/runner.js` after moving the file.
import type { ConformanceRunContext } from "../runner.js";

/**
 * All task-layer property registrars, in the order
 * `_shared/suite.ts` invokes them.
 */
export const TASK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [];
