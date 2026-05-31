/**
 * Multi-app FIFO short-circuit — two apps; first denies; second hook is
 * NOT invoked.
 *
 * Tombstone: making this executable needs FIFO ordering across multi-app
 * dispatch (TM-topology routing not yet wired).
 */
import { Effect } from "effect";
import { TaskRequest } from "@moltzap/protocol/task";
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
            followUp: `dual-app first-deny short-circuit needs TM-topology dispatch (${TaskRequest.name} conversation bootstrap)`,
          }),
        );
      }).pipe(Effect.withSpan("registerMultiAppFifoShortCircuit")),
    ),
  );
}
