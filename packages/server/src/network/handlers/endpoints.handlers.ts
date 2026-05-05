import { Effect } from "effect";
import {
  EndpointsRegisterTaskManager,
  EndpointsUnregisterTaskManager,
} from "@moltzap/protocol";
import { defineNetworkMethod } from "../../rpc/define-layered-method.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import type { TaskService } from "../../services/task.service.js";

export function createEndpointHandlers(deps: {
  taskService: TaskService;
}): RpcMethodRegistry {
  const { taskService } = deps;

  return [
    defineNetworkMethod(EndpointsRegisterTaskManager, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const result = yield* taskService.registerTm(
            params.taskId,
            ctx.agentId,
          );
          // Drop the brand for JSON encoding; receiver re-brands.
          return {
            taskId: result.taskId,
            tmEndpointAddress: String(result.tmEndpointAddress),
          };
        }),
    }),

    defineNetworkMethod(EndpointsUnregisterTaskManager, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* taskService.unregisterTm(params.taskId, ctx.agentId);
          return {};
        }),
    }),
  ];
}
