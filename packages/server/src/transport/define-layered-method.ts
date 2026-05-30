import { Effect } from "effect";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  makeErasedSlot,
  type CapabilityDescriptor,
  type CapIdentsOf,
  type CapProviders,
  type ErasedSlot,
  type ForbiddenError,
  type RpcDefinition,
} from "@moltzap/protocol";
import {
  defineMethod,
  type CtxForKind,
  type PrincipalKind,
} from "./context.js";
import type { ConnectionTag } from "../app/layers.js";
import type { Connection } from "./connection.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";
import type { AppTags, NetworkTags, TaskTags } from "./layer-tags.js";

/**
 * The residual `Env` a slot's `invoke` requires from the surrounding
 * `ManagedRuntime` — the layer service tags MINUS `ConnectionTag` (which
 * `defineMethod` provides per-frame from the live arm) and MINUS the
 * per-frame capability tags (discharged inside the slot). Each wrapper
 * pins its layer's variant; `Exclude&lt;…, ConnectionTag>` keeps the pin
 * honest so the slot does NOT claim a `ConnectionTag` the runtime never
 * supplies (it is request-scoped).
 */
type NetworkSlotEnv = Exclude<NetworkTags, ConnectionTag>;
type TaskSlotEnv = Exclude<TaskTags, ConnectionTag>;
type AppSlotEnv = Exclude<AppTags, ConnectionTag>;

/**
 * @file Per-layer RPC binding wrappers — #705 HALF-1 cast-free slot
 * cutover.
 *
 * Each `defineXMethod` wrapper composes TWO orthogonal axes onto one
 * {@link ErasedSlot}:
 *   - **Binding layer** — the `Reqs extends NetworkTags`/`TaskTags`/`AppTags`
 *     upper bound on the handler body's service-tag R-channel (the wrapper
 *     provides its `*LayerScope` markers structurally).
 *   - **Calling principal** — `callablePrincipal` (`agent`/`app`/`any`)
 *     types the body's `ctx` via `CtxForKind&lt;K>` and drives the #720
 *     principal-kind gate inside `defineMethod`'s slot handler.
 *
 * The wrapper PINS `makeErasedSlot`'s `Env` to its layer service-tag
 * union and `Conn` to the server's three-arm {@link Connection}, then
 * threads a positional `providers` tuple aligned 1:1 to the descriptor's
 * `capabilities` array. The slot's `invoke` discharges those caps INSIDE
 * (the pre-HALF-1 global `serverCapabilityProviders` table + the
 * `eraseHandlerTable`/`asNeverR` cascade are gone). The cross-package
 * handler-R ⊆ declared-caps lockstep is the `makeErasedSlot` typed bound
 * (`erased-slot.types-check.ts`).
 *
 * **Env pin is MANDATORY.** A free `Env` widens to swallow an undeclared
 * capability in the handler's R and the R⊆Caps lockstep goes false-green
 * (the `makeErasedSlot` JSDoc names this trap). Each wrapper turbofishes
 * its layer union as the last `makeErasedSlot` generic.
 *
 * **Type-alias hierarchy + maintenance contract.** See `./layer-tags.ts`
 * for the allowlist. Adding a new service Tag is a TWO-step edit:
 * update `layer-tags.ts` AND `architectureOptions.layers` in the root
 * `eslint.config.js` so the structural lint and the type system agree.
 */

/**
 * The handler + principal shape each `defineXMethod` accepts. `Required`
 * is the handler body's R-channel upper bound (the layer service tags +
 * the per-frame capability tag identifiers the body yields via service
 * calls). The wrapper provides its `*LayerScope` markers, pins `Env`,
 * and threads the `providers` tuple.
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
 * The descriptor shape the wrappers consume: a `defineRpc` return whose
 * `capabilities` is the literal tuple `CapsTuple` (sourced from the
 * `defineRpc` RETURN, never `never`). `makeErasedSlot` `Omit`s the wide
 * optional `capabilities?` off `RpcDefinition` and re-intersects the
 * clean tuple; the wrappers mirror that so the tuple flows through.
 */
type SlotDefinition<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
> = Omit<RpcDefinition<Name, P, R>, "capabilities"> & {
  readonly capabilities: CapsTuple;
};

/**
 * Network-layer RPC binding. Handler `R`-channel is
 * `Reqs extends NetworkTags`; provides `NetworkLayerScope` structurally.
 * The per-frame capability identifiers ride via `CapProviders&lt;CapsTuple>`
 * inside `makeErasedSlot`'s bound (NOT a separate `| CapabilityTags` on
 * `Reqs` — the slot discharges them).
 */
export function defineNetworkMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends PrincipalKind,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  E = never,
  Reqs extends NetworkTags = NetworkTags,
>(
  definition: SlotDefinition<Name, P, R, CapsTuple>,
  def: MethodDef<P, R, Reqs | CapIdentsOf<CapsTuple> | NetworkLayerScope, E, K>,
  providers: CapProviders<CapsTuple, NetworkSlotEnv>,
): ErasedSlot<NetworkSlotEnv, Connection> {
  const gated = defineMethod(definition, {
    callablePrincipal: def.callablePrincipal,
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(Effect.provideService(NetworkLayerScope, undefined)),
    requiresActive: def.requiresActive,
  });
  return makeErasedSlot<
    Name,
    P,
    R,
    E | ForbiddenError,
    Connection,
    CapsTuple,
    NetworkSlotEnv
  >(definition, gated, providers);
}

/**
 * Task-layer RPC binding. Handler `R`-channel is `Reqs extends TaskTags`;
 * provides `NetworkLayerScope` and `TaskLayerScope` structurally. Per-frame
 * capability tags ride via `CapProviders&lt;CapsTuple>` (the slot discharges
 * them) — NOT a `| CapabilityTags` widening on `Reqs`.
 *
 * See `defineNetworkMethod` for the maintenance contract.
 */
export function defineTaskMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends PrincipalKind,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  E = never,
  Reqs extends TaskTags = TaskTags,
>(
  definition: SlotDefinition<Name, P, R, CapsTuple>,
  def: MethodDef<
    P,
    R,
    Reqs | CapIdentsOf<CapsTuple> | NetworkLayerScope | TaskLayerScope,
    E,
    K
  >,
  providers: CapProviders<CapsTuple, TaskSlotEnv>,
): ErasedSlot<TaskSlotEnv, Connection> {
  const gated = defineMethod(definition, {
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
  return makeErasedSlot<
    Name,
    P,
    R,
    E | ForbiddenError,
    Connection,
    CapsTuple,
    TaskSlotEnv
  >(definition, gated, providers);
}

/**
 * App-layer RPC binding. Handler `R`-channel is `Reqs extends AppTags`;
 * provides all three layer scopes structurally. Per-frame capability tags
 * ride via `CapProviders&lt;CapsTuple>` (the slot discharges them).
 *
 * See `defineNetworkMethod` for the maintenance contract.
 */
export function defineAppMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends PrincipalKind,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  E = never,
  Reqs extends AppTags = AppTags,
>(
  definition: SlotDefinition<Name, P, R, CapsTuple>,
  def: MethodDef<
    P,
    R,
    | Reqs
    | CapIdentsOf<CapsTuple>
    | NetworkLayerScope
    | TaskLayerScope
    | AppLayerScope,
    E,
    K
  >,
  providers: CapProviders<CapsTuple, AppSlotEnv>,
): ErasedSlot<AppSlotEnv, Connection> {
  const gated = defineMethod(definition, {
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
  return makeErasedSlot<
    Name,
    P,
    R,
    E | ForbiddenError,
    Connection,
    CapsTuple,
    AppSlotEnv
  >(definition, gated, providers);
}
