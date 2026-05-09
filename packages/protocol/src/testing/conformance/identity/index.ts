/**
 * Identity-layer conformance properties.
 *
 * Authority + agent-identity invariants — who is allowed to call what,
 * positive-path authority checks, negative-path rejections.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `IDENTITY_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 *
 * Phase 1A interface stub. Implementer (sub-issue #546) carves the
 * per-property files out of `rpc-semantics.ts` (`registerAuthorityPositive`,
 * `registerAuthorityNegative`).
 */
// During Phase 1A interface-stub phase the runner still lives at the
// legacy `conformance/runner.ts` location. Implementer (sub-issue #546)
// rewrites this import to `../_shared/runner.js` after moving the file.
import type { ConformanceRunContext } from "../runner.js";

/**
 * All identity-layer property registrars, in the order
 * `_shared/suite.ts` invokes them.
 */
export const IDENTITY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [];
