import { Effect } from "effect";
import type { RpcDefinition, Static, TSchema } from "@moltzap/protocol";
import {
  defineMethod,
  type AuthenticatedContext,
  type RpcMethodBinding,
} from "../../rpc/context.js";
import type { RpcFailure } from "../../runtime/index.js";
import type { ConnIdTag } from "../../app/layers.js";
import { NetworkLayerScope } from "../../network/layer-scope.js";
import { TaskLayerScope } from "../layer-scope.js";

const NETWORK_SCOPE: { readonly _: "NetworkLayerScope" } = {
  _: "NetworkLayerScope",
};
const TASK_SCOPE: { readonly _: "TaskLayerScope" } = {
  _: "TaskLayerScope",
};

export function defineTaskMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    handler: (
      params: Static<P>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<
      Static<R>,
      RpcFailure,
      ConnIdTag | NetworkLayerScope | TaskLayerScope
    >;
    requiresActive?: boolean;
  },
): RpcMethodBinding<RpcDefinition<Name, P, R>> {
  return defineMethod(definition, {
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(
          Effect.provideService(NetworkLayerScope, NETWORK_SCOPE),
          Effect.provideService(TaskLayerScope, TASK_SCOPE),
        ),
    requiresActive: def.requiresActive,
  });
}
