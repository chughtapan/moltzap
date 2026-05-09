/** Backpressure — DEFERRED to epic #186. */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyDeferred, registerProperty } from "../_shared/registry.js";

const CATEGORY = "adversity" as const;

export function registerBackpressure(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "backpressure",
    "backpressure property deferred to #186 — BackpressurePolicy not extant",
    Effect.fail(
      new PropertyDeferred({
        category: CATEGORY,
        name: "backpressure",
        followUp: "https://github.com/chughtapan/moltzap/issues/186",
      }),
    ),
  );
}
