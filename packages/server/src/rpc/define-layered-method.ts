import { Effect } from "effect";
import type { RpcDefinition, Static, TSchema } from "@moltzap/protocol";
import {
  defineMethod,
  type AuthenticatedContext,
  type RpcMethodBinding,
} from "./context.js";
import type { RpcFailure } from "../runtime/index.js";
import type { ConnIdTag } from "../app/layers.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";

type NetworkR = ConnIdTag | NetworkLayerScope;
type TaskR = NetworkR | TaskLayerScope;
type AppR = TaskR | AppLayerScope;

interface MethodDef<P extends TSchema, R extends TSchema, Required> {
  readonly handler: (
    params: Static<P>,
    ctx: AuthenticatedContext,
  ) => Effect.Effect<Static<R>, RpcFailure, Required>;
  readonly requiresActive?: boolean;
}

export function defineNetworkMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, NetworkR>,
): RpcMethodBinding<RpcDefinition<Name, P, R>> {
  return defineMethod(definition, {
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(Effect.provideService(NetworkLayerScope, undefined)),
    requiresActive: def.requiresActive,
  });
}

export function defineTaskMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, TaskR>,
): RpcMethodBinding<RpcDefinition<Name, P, R>> {
  return defineMethod(definition, {
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(
          Effect.provideService(NetworkLayerScope, undefined),
          Effect.provideService(TaskLayerScope, undefined),
        ),
    requiresActive: def.requiresActive,
  });
}

export function defineAppMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, AppR>,
): RpcMethodBinding<RpcDefinition<Name, P, R>> {
  return defineMethod(definition, {
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(
          Effect.provideService(NetworkLayerScope, undefined),
          Effect.provideService(TaskLayerScope, undefined),
          Effect.provideService(AppLayerScope, undefined),
        ),
    requiresActive: def.requiresActive,
  });
}
