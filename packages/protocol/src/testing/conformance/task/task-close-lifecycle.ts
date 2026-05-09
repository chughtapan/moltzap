/**
 * Task close lifecycle — close is observable as both conversation
 * archival and task/closed, and the archived task conversation rejects
 * later traffic.
 *
 * Phase 7 cutover dropped the apps/createSession bootstrap that wired
 * manifest conversations to a session. The replacement TM-topology
 * bootstrap lands in a follow-up issue (replaces #318); this property
 * stays tombstoned until the bootstrap exists.
 *
 * Disposition (Phase 1A architect §5): RETOMBSTONE — flip-to-executable
 * is a behavioral change outside Phase 1A's structural scope.
 */
import { Effect } from "effect";
import { TasksClose } from "../../../task/methods.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyDeferred, registerProperty } from "../_shared/registry.js";

// Property ID stays at `delivery/task-close-lifecycle` to preserve the
// pre/post conformance baseline (#546 §7). Architect §7: "registry
// `category` derived from the call-site, not file path."
const CATEGORY = "delivery" as const;
const PROPERTY = "task-close-lifecycle";

export function registerTaskCloseLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "tasks/close archives task conversations and broadcasts task/closed",
    Effect.scoped(
      Effect.gen(function* () {
        void ctx;
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: PROPERTY,
            followUp: `#556 wires task/closed emission + manifest conversation bootstrap (${TasksClose.name})`,
          }),
        );
      }),
    ),
  );
}
