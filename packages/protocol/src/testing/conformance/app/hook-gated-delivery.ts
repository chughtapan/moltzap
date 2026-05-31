/**
 * Hook-gated delivery — admission verbs are awaitable, the verdict
 * mutates the recipient view, dynamically attached conversations enter
 * the hook pipeline.
 *
 * Tombstone: making this executable needs hook-RPC infrastructure not
 * yet present. The property ID stays `delivery/hook-gated-delivery` —
 * the registry category derives from the call-site, not the file path.
 */
import { Effect } from "effect";
import { TaskRequest } from "../../../task/methods.js";
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
            followUp: `deny/patch/attach assertions need TM-topology hook routing (${TaskRequest.name} conversation bootstrap)`,
          }),
        );
      }).pipe(Effect.withSpan("registerHookGatedDelivery")),
    ),
  );
}
