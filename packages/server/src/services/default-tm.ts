/**
 * In-process default task managers (DM + group).
 *
 * Phase 9b consumer-migration (sub-issue #460 round 3 R14 + round 4
 * R21): every conversation belongs to a task; every task has a
 * registered TM. Non-app DMs / groups (the `conversations/create`
 * auto-task path) route through these default TMs at the stable
 * addresses `DEFAULT_DM_TM_ADDRESS` / `DEFAULT_GROUP_TM_ADDRESS`. The
 * handler is a no-op observer — `MessageService.send` continues to
 * insert + broadcast the message via the existing path; the default
 * TM exists primarily to satisfy the schema-level NOT NULL constraint
 * on `tasks.tm_endpoint_address`.
 *
 * Round 4 R21 (simplify): pre-R21 the DM and group handlers lived in
 * separate modules with byte-identical bodies (~25 lines duplicated).
 * Collapsed to one factory; the kind label drives the log key so
 * future differentiation (group admin policy, larger-N rate limits)
 * still has a single seam to extend.
 */
import { Effect } from "effect";
import { logger } from "../logger.js";
import type { AppTmHandler } from "../network/app-tm-registry.js";

export type DefaultTmKind = "dm" | "group";

/**
 * Construct an in-process default-TM handler for `kind` ∈ {dm, group}.
 * The factory accepts no dependencies today; future evolutions
 * (rate-limit store, audit sink) plumb through here.
 */
export function makeDefaultTmHandler(kind: DefaultTmKind): AppTmHandler {
  const tmLabel = `default-${kind}-tm`;
  return (payload) =>
    Effect.sync(() => {
      // Log at info (the lowest level the server logger emits today).
      // Drops the payload bytes — the server's existing trace-capture
      // surface owns full message persistence.
      logger.info(
        { payloadBytes: payload.length, tm: tmLabel },
        `${tmLabel} observed inbound message frame`,
      );
    });
}
