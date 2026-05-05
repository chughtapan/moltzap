import type { PresenceService } from "../../services/presence.service.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import { PresenceUpdate, PresenceSubscribe } from "@moltzap/protocol";
import { Effect } from "effect";
import { ConnIdTag } from "../../app/layers.js";

export function createPresenceHandlers(deps: {
  presenceService: PresenceService;
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
      handler: (params) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          deps.presenceService.subscribe(connId, params.agentIds);
          const statuses = deps.presenceService.getMany(params.agentIds);
          return { statuses };
        }),
    }),
  ];
}
