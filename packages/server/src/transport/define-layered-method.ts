import { Effect } from "effect";
import type { Static, TSchema } from "@sinclair/typebox";
import type { RpcDefinition } from "@moltzap/protocol";
import {
  defineMethod,
  type AuthenticatedContext,
  type RpcMethodBinding,
} from "./context.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";
import type { AppTags, NetworkTags, TaskTags } from "./layer-tags.js";

interface MethodDef<P extends TSchema, R extends TSchema, Required, E> {
  readonly handler: (
    params: Static<P>,
    ctx: AuthenticatedContext,
  ) => Effect.Effect<Static<R>, E, Required>;
  readonly requiresActive?: boolean;
}

/**
 * Network-layer RPC method binding. Handler `R`-channel is
 * `Reqs extends NetworkTags`; the wrapper provides `NetworkLayerScope`
 * structurally and the dispatcher's `ManagedRuntime` provides every
 * service Tag at request time.
 *
 * `Reqs` defaults to `NetworkTags` so a handler that yields no service
 * Tag (the pre-2A.0 factory shape) infers `Reqs = never` via R-channel
 * covariance and compiles unchanged. A handler that yields a Tag from a
 * higher layer (e.g. `MessageServiceTag`, which is `TaskTags` only)
 * fails the constraint at the call site.
 *
 * **Type-alias hierarchy.** See `./layer-tags.ts` for the full
 * allowlist. Adding a new service Tag is a TWO-step edit per the
 * maintenance contract: update `layer-tags.ts` AND
 * `architectureOptions.layers` in the root `eslint.config.js` so the
 * structural lint and the type system agree.
 */
export function defineNetworkMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
  Reqs extends NetworkTags = NetworkTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, Reqs | NetworkLayerScope, E>,
): RpcMethodBinding {
  return defineMethod(definition, {
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(Effect.provideService(NetworkLayerScope, undefined)),
    requiresActive: def.requiresActive,
  });
}

/**
 * Task-layer RPC method binding. Handler `R`-channel is
 * `Reqs extends TaskTags`; provides `NetworkLayerScope` and
 * `TaskLayerScope` structurally.
 *
 * See `defineNetworkMethod` for the maintenance contract.
 */
export function defineTaskMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
  Reqs extends TaskTags = TaskTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, Reqs | NetworkLayerScope | TaskLayerScope, E>,
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

/**
 * App-layer RPC method binding. Handler `R`-channel is
 * `Reqs extends AppTags`; provides all three layer scopes
 * structurally.
 *
 * See `defineNetworkMethod` for the maintenance contract.
 */
export function defineAppMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
  Reqs extends AppTags = AppTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<
    P,
    R,
    Reqs | NetworkLayerScope | TaskLayerScope | AppLayerScope,
    E
  >,
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
