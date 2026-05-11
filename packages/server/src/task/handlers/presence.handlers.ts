import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import {
  PresenceUpdate,
  PresenceSubscribe,
  NotInContactsError,
} from "@moltzap/protocol";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import { Effect } from "effect";
import { ConnIdTag, DbTag, PresenceServiceTag } from "../../app/layers.js";
import { visibleAgentIds } from "../../services/agent-visibility.js";

export const presenceHandlers: RpcMethodRegistry = [
  defineTaskMethod(PresenceUpdate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const presenceService = yield* PresenceServiceTag;
        const senderConnId = yield* ConnIdTag;
        presenceService.update(ctx.agentId, params.status, {
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
        const presenceService = yield* PresenceServiceTag;
        const db = yield* DbTag;
        const connId = yield* ConnIdTag;
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
        presenceService.subscribe(connId, visibleIds);
        const statuses = presenceService.getMany(visibleIds);
        return { statuses };
      }),
  }),
];
