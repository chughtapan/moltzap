import type { PresenceService } from "../../services/presence.service.js";
import type { Db } from "../../db/client.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import {
  PresenceUpdate,
  PresenceSubscribe,
  NotInContactsError,
} from "@moltzap/protocol";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import { Effect } from "effect";
import { ConnIdTag } from "../../app/layers.js";
import { visibleAgentIds } from "../../services/agent-visibility.js";

export function createPresenceHandlers(deps: {
  presenceService: PresenceService;
  db: Db;
}): RpcMethodRegistry {
  return [
    defineTaskMethod(PresenceUpdate, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const senderConnId = yield* ConnIdTag;
          deps.presenceService.update(ctx.agentId, params.status, {
            excludeConnId: senderConnId,
          });
          return {};
        }),
    }),
    defineTaskMethod(PresenceSubscribe, {
      requiresActive: true,
      // Contact-scoped per #481/#508: throw NotInContactsError when any
      // requested agentId falls outside the caller's visibility set.
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          const requested = params.agentIds as ServerAgentId[];
          const visibleIds = yield* visibleAgentIds({
            db: deps.db,
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
          deps.presenceService.subscribe(connId, visibleIds);
          const statuses = deps.presenceService.getMany(visibleIds);
          return { statuses };
        }),
    }),
  ];
}
