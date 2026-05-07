import type { PresenceService } from "../../services/presence.service.js";
import type { Db } from "../../db/client.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import { PresenceUpdate, PresenceSubscribe } from "@moltzap/protocol";
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
      // Contact-scoped per #481: silently drop any agentId outside the
      // caller's visibility set.
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          const visibleIds = yield* visibleAgentIds({
            db: deps.db,
            callerAgentId: ctx.agentId,
            callerOwnerUserId: ctx.ownerUserId,
            restrictTo: params.agentIds as ServerAgentId[],
          });
          deps.presenceService.subscribe(connId, visibleIds);
          const statuses = deps.presenceService.getMany(visibleIds);
          return { statuses };
        }),
    }),
  ];
}
