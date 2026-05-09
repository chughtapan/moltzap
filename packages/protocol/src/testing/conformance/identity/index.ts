/**
 * Identity-layer conformance properties.
 *
 * Authority + agent-identity invariants — who is allowed to call what,
 * positive-path authority checks, negative-path rejections.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `IDENTITY_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerAuthorityPositive } from "./authority-positive.js";
import { registerAuthorityNegative } from "./authority-negative.js";

export { registerAuthorityPositive, registerAuthorityNegative };

/**
 * All identity-layer property registrars in legacy walk order
 * (authority-positive → authority-negative).
 */
export const IDENTITY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [registerAuthorityPositive, registerAuthorityNegative];
