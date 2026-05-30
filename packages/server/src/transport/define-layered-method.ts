import { Effect } from "effect";
import type { Static, TSchema } from "@sinclair/typebox";
import type { RpcDefinition } from "@moltzap/protocol";
import {
  defineMethod,
  type CtxForKind,
  type PrincipalKind,
  type RpcMethodBinding,
} from "./context.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";
import type {
  AppTags,
  CapabilityTags,
  NetworkTags,
  TaskTags,
} from "./layer-tags.js";

/**
 * #705 #720 §B1 — the handler's `ctx` type is a function of the binding's
 * declared `callablePrincipal` (via the `CtxForKind` conditional type). A
 * `callablePrincipal: "app"`
 * binding forces `ctx: AppContext`; a body reading `ctx.agentId` fails TS2339,
 * and a `(ctx: AgentContext)` lambda fails TS2345. The `callablePrincipal`
 * field is REQUIRED (no default) — omitting it is TS2554. The bind layer
 * (`defineNetworkMethod`/`defineTaskMethod`/`defineAppMethod`) stays orthogonal
 * to the principal kind: a `defineAppMethod` binding may carry
 * `callablePrincipal: "agent"` (e.g. `task/request`, `dispatch/request`).
 */
interface MethodDef<
  P extends TSchema,
  R extends TSchema,
  Required,
  E,
  K extends PrincipalKind,
> {
  readonly callablePrincipal: K;
  readonly handler: (
    params: Static<P>,
    ctx: CtxForKind<K>,
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
  K extends PrincipalKind,
  E = never,
  Reqs extends NetworkTags = NetworkTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, Reqs | NetworkLayerScope, E, K>,
): RpcMethodBinding {
  return defineMethod(definition, {
    callablePrincipal: def.callablePrincipal,
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(Effect.provideService(NetworkLayerScope, undefined)),
    requiresActive: def.requiresActive,
  });
}

/**
 * Task-layer RPC method binding. Handler `R`-channel is
 * `Reqs extends TaskTags | CapabilityTags`; provides `NetworkLayerScope`
 * and `TaskLayerScope` structurally. Capability tags are admitted so
 * the typed dispatcher's auto-provision step can fill them from the
 * descriptor's `capabilities` array. The cross-package lockstep
 * (handler R ⊆ `CapabilitiesOf&lt;D>`) is enforced at
 * `typed-dispatcher.types-check.ts`.
 *
 * See `defineNetworkMethod` for the maintenance contract.
 */
export function defineTaskMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends PrincipalKind,
  E = never,
  Reqs extends TaskTags | CapabilityTags = TaskTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<P, R, Reqs | NetworkLayerScope | TaskLayerScope, E, K>,
): RpcMethodBinding {
  return defineMethod(definition, {
    callablePrincipal: def.callablePrincipal,
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
 * `Reqs extends AppTags | CapabilityTags`; provides all three layer
 * scopes structurally. Capability tags admit auto-provision.
 *
 * See `defineNetworkMethod` for the maintenance contract.
 */
export function defineAppMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends PrincipalKind,
  E = never,
  Reqs extends AppTags | CapabilityTags = AppTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MethodDef<
    P,
    R,
    Reqs | NetworkLayerScope | TaskLayerScope | AppLayerScope,
    E,
    K
  >,
): RpcMethodBinding {
  return defineMethod(definition, {
    callablePrincipal: def.callablePrincipal,
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
