/**
 * Multi-app FIFO short-circuit — two apps; first denies; second hook is
 * NOT invoked.
 *
 * Phase 1A architect §5 disposition: RETOMBSTONE — flip-to-executable
 * needs FIFO ordering across multi-app dispatch (TM-topology routing
 * not yet wired), and is implementer-tier behavior change outside Phase
 * 1A's structural scope.
 */
import { Effect } from "effect";
import { TaskCreate } from "@moltzap/protocol/task";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyDeferred, registerProperty } from "../_shared/registry.js";

const CATEGORY = "delivery" as const;
const PROPERTY = "multi-app-fifo-short-circuit";

export function registerMultiAppFifoShortCircuit(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "two apps; first denies; second hook is NOT invoked",
    Effect.scoped(
      Effect.gen(function* () {
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: PROPERTY,
            followUp: `dual-app first-deny short-circuit needs TM-topology dispatch; reactivate alongside #555 (${TaskCreate.name} bootstrap)`,
          }),
        );
      }).pipe(Effect.withSpan("registerMultiAppFifoShortCircuit")),
    ),
  );
}
