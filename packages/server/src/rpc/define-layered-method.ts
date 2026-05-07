import { Effect } from "effect";
import type { Static, TSchema } from "@sinclair/typebox";
import type { RpcDefinition } from "@moltzap/protocol";
import {
  defineMethod,
  type AuthenticatedContext,
  type RpcMethodBinding,
} from "./context.js";
import type { ConnIdTag } from "../app/layers.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";

type NetworkR = ConnIdTag | NetworkLayerScope;
type TaskR = NetworkR | TaskLayerScope;
type AppR = TaskR | AppLayerScope;

interface MethodDef<P extends TSchema, R extends TSchema, Required, E> {
  readonly handler: (
    params: Static<P>,
    ctx: AuthenticatedContext,
  ) => Effect.Effect<Static<R>, E, Required>;
  readonly requiresActive?: boolean;
}

export function defineNetworkMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, NetworkR, E>,
): RpcMethodBinding {
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
  E = never,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, TaskR, E>,
): RpcMethodBinding {
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
  E = never,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, AppR, E>,
): RpcMethodBinding {
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
