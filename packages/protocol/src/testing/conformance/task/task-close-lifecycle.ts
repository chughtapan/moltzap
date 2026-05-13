/**
 * Task close lifecycle — `tasks/close` flips task status to `closed`,
 * after which `messages/send` to a conversation in that task fails
 * closed with `TaskClosedError` (wire code -32020).
 *
 * The pre-#546 acceptance criteria additionally named a `task/closed`
 * notification and cascade-archive of task conversations; neither
 * surface exists in the current TM-topology architecture (#460 R12
 * left `tm_endpoint_address` populated post-close and gates message
 * delivery on `task.status` directly, with no notification fan-out
 * and no per-conversation `archived_at` write). This property
 * encodes what `tasks/close` actually observably does today; the
 * shape extension for fan-out is tracked separately and is a
 * spec-tier change, not implementer-tier.
 */
import { Effect, Either } from "effect";
import { TaskClosedError } from "@moltzap/protocol/task";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";
import { RpcResponseError } from "../_shared/errors.js";
import {
  DELIVERY_CATEGORY,
  acquireTaskBoundConversation,
  closeTask,
  deliveryViolation,
  sendText,
} from "./_helpers.js";

const PROPERTY = "task-close-lifecycle";

export function registerTaskCloseLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "tasks/close flips task status; subsequent messages/send fails with TaskClosed",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireTaskBoundConversation(ctx, "tcl").pipe(
          Effect.mapError((reason) =>
            deliveryViolation(PROPERTY, `fixture: ${reason}`),
          ),
        );
        // Task is open: sender's first message round-trips. This arm
        // proves the fixture actually plumbs the TM correctly — without
        // it, the post-close failure could trivially pass against a
        // server that rejects every send for the wrong reason.
        const beforeClose = yield* sendText(
          fixture.sender,
          fixture.conversationId,
          "before-close",
        ).pipe(Effect.either);
        yield* requireRight(beforeClose, (error) =>
          deliveryViolation(
            PROPERTY,
            `messages/send before close failed: ${error._tag}`,
          ),
        );

        // Owner is the registered TM (`tmType: "self"` resolves to
        // `tm:agent:<owner>`), so `tasks/close` is authorized.
        const closed = yield* closeTask(fixture.owner, fixture.taskId).pipe(
          Effect.either,
        );
        yield* requireRight(closed, (error) =>
          deliveryViolation(PROPERTY, `tasks/close failed: ${error._tag}`),
        );

        // Post-close: `messages/send` reads `task.status = "closed"`
        // through the conversation join and fails with the typed
        // `TaskClosed` wire error (`code = -32020`). A server that
        // accepted the send would surface as a Right; a server that
        // returned a different wire code would surface as a Left
        // mismatching `TaskClosedError.code`.
        const afterClose = yield* sendText(
          fixture.sender,
          fixture.conversationId,
          "after-close",
        ).pipe(Effect.either);
        const violation = Either.match(afterClose, {
          onRight: () =>
            deliveryViolation(
              PROPERTY,
              "messages/send succeeded after tasks/close",
            ),
          onLeft: (error) => {
            if (
              error instanceof RpcResponseError &&
              error.code === TaskClosedError.code
            ) {
              return null;
            }
            const errorLabel =
              error instanceof RpcResponseError
                ? `${error._tag}/${error.code}`
                : error._tag;
            return deliveryViolation(
              PROPERTY,
              `messages/send returned ${errorLabel}, expected TaskClosed`,
            );
          },
        });
        if (violation !== null) {
          return yield* Effect.fail(violation);
        }
      }).pipe(Effect.withSpan("registerTaskCloseLifecycle")),
    ),
  );
}
