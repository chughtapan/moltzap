/**
 * Hook-gated delivery — admission verbs are awaitable, the verdict
 * mutates the recipient view, dynamically attached conversations enter
 * the hook pipeline.
 *
 * Stays deferred: the TM-topology hook routing surface this property
 * exercises (`runMessageAuthorize`) is plan-approved in #560 but
 * landed only as an architect stub (`Effect.dieMessage`). Until that
 * stub gains a body, no in-process or remote hook can return `Block`
 * for the property to assert against. Property ID stays at
 * `delivery/hook-gated-delivery` to preserve the conformance
 * baseline (architect §7 — registry category derives from the
 * call-site, not the file path).
 */
import { Effect } from "effect";
import { TasksCreate } from "@moltzap/protocol/task";
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
        void ctx;
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: PROPERTY,
            followUp: `block-arm assertion blocks on #560 wiring runMessageAuthorize (architect-stub today); property reactivates when the hook dispatch path returns a verdict (${TasksCreate.name} bootstrap remains the fixture entry).`,
          }),
        );
      }),
    ),
  );
}
