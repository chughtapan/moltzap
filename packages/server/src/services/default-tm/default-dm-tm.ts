/**
 * In-process default DM task manager.
 *
 * Phase 9b consumer-migration (sub-issue #460 round 3 R14): every
 * conversation belongs to a task; every task has a registered TM. Non-
 * app DMs (the `conversations/create` auto-task path with
 * `type: "dm"`) route through this default TM at the stable address
 * `tm:app:<DEFAULT_DM_TM_ADDRESS>`. The handler is a no-op observer —
 * `MessageService.send` continues to insert + broadcast the message
 * via the existing path; the default TM exists primarily to satisfy
 * the schema-level NOT NULL constraint on `tasks.tm_endpoint_address`.
 *
 * Future Phase 11+ arena cutover may extend this with policy logic
 * (rate limits, content filters, per-DM display semantics). Today the
 * handler logs and returns.
 */
import { Effect } from "effect";
import { logger } from "../../logger.js";
import type { AppTmHandler } from "../../network/app-tm-registry.js";

/**
 * Construct the default-DM-TM handler. The factory accepts no
 * dependencies today; future evolutions (rate-limit store, audit
 * sink) plumb through here.
 */
export function makeDefaultDmTmHandler(): AppTmHandler {
  return (payload) =>
    Effect.sync(() => {
      // Log at debug-equivalent (info is the lowest level the server
      // logger emits today). Drops the payload bytes — the server's
      // existing trace-capture surface owns full message persistence.
      logger.info(
        { payloadBytes: payload.length, tm: "default-dm-tm" },
        "default-dm-tm observed inbound message frame",
      );
    });
}
