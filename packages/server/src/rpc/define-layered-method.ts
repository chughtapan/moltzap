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
  APP_SCOPE,
  NetworkLayerScope,
  NETWORK_SCOPE,
  TaskLayerScope,
  TASK_SCOPE,
} from "./layer-scopes.js";

type NetworkR = ConnIdTag | NetworkLayerScope;
type TaskR = NetworkR | TaskLayerScope;
type AppR = TaskR | AppLayerScope;

const provideNetwork = <A, E>(
  e: Effect.Effect<A, E, NetworkR>,
): Effect.Effect<A, E, ConnIdTag> =>
  e.pipe(Effect.provideService(NetworkLayerScope, NETWORK_SCOPE));

const provideTask = <A, E>(
  e: Effect.Effect<A, E, TaskR>,
): Effect.Effect<A, E, ConnIdTag> =>
  e.pipe(
    Effect.provideService(NetworkLayerScope, NETWORK_SCOPE),
    Effect.provideService(TaskLayerScope, TASK_SCOPE),
  );

const provideApp = <A, E>(
  e: Effect.Effect<A, E, AppR>,
): Effect.Effect<A, E, ConnIdTag> =>
  e.pipe(
    Effect.provideService(NetworkLayerScope, NETWORK_SCOPE),
    Effect.provideService(TaskLayerScope, TASK_SCOPE),
    Effect.provideService(AppLayerScope, APP_SCOPE),
  );

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
    handler: (params, ctx) => provideNetwork(def.handler(params, ctx)),
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
    handler: (params, ctx) => provideTask(def.handler(params, ctx)),
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
    handler: (params, ctx) => provideApp(def.handler(params, ctx)),
    requiresActive: def.requiresActive,
  });
}
