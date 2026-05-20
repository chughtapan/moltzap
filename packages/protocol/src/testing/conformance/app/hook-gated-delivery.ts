/**
 * Hook-gated delivery — admission verbs are awaitable, the verdict
 * mutates the recipient view, dynamically attached conversations enter
 * the hook pipeline.
 *
 * Phase 1A architect §5 disposition: RETOMBSTONE — flip-to-executable
 * needs hook-RPC infrastructure that the layered refactor reshaped, and
 * is implementer-tier behavior change outside Phase 1A's structural
 * scope. Property ID stays at `delivery/hook-gated-delivery` to preserve
 * the conformance baseline (architect §7 — registry category derives
 * from the call-site, not the file path).
 */
import { Effect } from "effect";
import { TaskCreate } from "../../../task/methods.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyDeferred, registerProperty } from "../_shared/registry.js";

const CATEGORY = "delivery" as const;
const PROPERTY = "hook-gated-delivery";

export function registerHookGatedDelivery(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "deny drops; patch mutates recipient view; attached conv enters hooks",
    Effect.scoped(
      Effect.gen(function* () {
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: PROPERTY,
            followUp: `deny/patch/attach assertions need TM-topology hook routing; reactivate alongside #554 (${TaskCreate.name} bootstrap)`,
          }),
        );
      }).pipe(Effect.withSpan("registerHookGatedDelivery")),
    ),
  );
}
