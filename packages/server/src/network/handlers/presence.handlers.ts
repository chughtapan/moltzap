import type { RpcMethodRegistry } from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import { PresenceSubscribe, NotInContactsError } from "@moltzap/protocol";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import { Effect } from "effect";
import { ConnectionTag, DbTag, PresenceServiceTag } from "../../app/layers.js";
import { PresenceProjectionTag } from "../services/presence-projection.js";
import { visibleAgentIds } from "../../identity/services/agent-visibility.js";

/**
 * Presence RPC handlers.
 *
 * **Architect plan #706 v7 (codex r6 P2 #2) — narrowed surface.** The
 * `PresenceUpdate` RPC handler was deleted along with the `PresenceUpdate`
 * descriptor (impl-staff lands the protocol-package deletion + barrel
 * cleanup as part of the §8 cutover). The surviving `presence/subscribe`
 * handler reads status snapshots from `PresenceProjection.statusMany`
 * (v3 codex r2 P2 #1) instead of the deleted `PresenceService.getMany`;
 * subscriber-registry mutation stays on `PresenceService.subscribe`.
 */
export const presenceHandlers: RpcMethodRegistry = [
  defineTaskMethod(PresenceSubscribe, {
    requiresActive: true,
    // Contact-scoped per #481/#508: throw NotInContactsError when any
    // requested agentId falls outside the caller's visibility set.
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const presenceService = yield* PresenceServiceTag;
        const presenceProjection = yield* PresenceProjectionTag;
        const db = yield* DbTag;
        const connection = yield* ConnectionTag;
        const requested = params.agentIds as ServerAgentId[];
        const visibleIds = yield* visibleAgentIds({
          db,
          callerAgentId: ctx.agentId,
          callerOwnerUserId: ctx.ownerUserId,
          restrictTo: requested,
        });
        const visibleSet = new Set(visibleIds);
        const rejected = requested.filter((id) => !visibleSet.has(id));
        if (rejected.length > 0) {
          return yield* Effect.fail(
            new NotInContactsError({ data: { agentIds: rejected } }),
          );
        }
        presenceService.subscribe(connection.id, visibleIds);
        // v7 (codex r6 P2 #2): status snapshot from the projection,
        // not the deleted PresenceService.getMany. The projection's
        // result is a ReadonlyArray; the wire schema expects a
        // mutable Array, so we spread to a fresh array (one-frame
        // copy; safe — the snapshot is point-in-time).
        const projected = yield* presenceProjection.statusMany(visibleIds);
        const statuses = projected.map((entry) => ({
          agentId: entry.agentId,
          status: entry.status,
        }));
        return { statuses };
      }).pipe(Effect.withSpan("presence.subscribe")),
  }),
];
