/**
 * In-process default group task manager.
 *
 * Phase 9b consumer-migration (sub-issue #460 round 3 R14): every
 * conversation belongs to a task; every task has a registered TM. Non-
 * app group conversations (the `conversations/create` auto-task path
 * with `type: "group"`) route through this default TM at the stable
 * address `tm:app:<DEFAULT_GROUP_TM_ADDRESS>`. The handler is a no-op
 * observer — `MessageService.send` continues to insert + broadcast the
 * message via the existing path; the default TM exists primarily to
 * satisfy the schema-level NOT NULL constraint on
 * `tasks.tm_endpoint_address`.
 *
 * Today the dm-tm and group-tm handlers are identical. They are kept
 * as separate modules so future differentiation (group admin policy,
 * larger-N rate limits) can land without rewiring callers.
 */
import { Effect } from "effect";
import { logger } from "../../logger.js";
import type { AppTmHandler } from "../../network/app-tm-registry.js";

export function makeDefaultGroupTmHandler(): AppTmHandler {
  return (payload) =>
    Effect.sync(() => {
      logger.info(
        { payloadBytes: payload.length, tm: "default-group-tm" },
        "default-group-tm observed inbound message frame",
      );
    });
}
