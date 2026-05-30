import { Effect } from "effect";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  makeErasedSlot,
  makeMiddlewareSlot,
  type AnyCapabilityMiddleware,
  type CapabilityDescriptor,
  type CapIdentsOf,
  type CapProviders,
  type CurrentPrincipal,
  type ErasedSlot,
  type ForbiddenError,
  type MiddlewaresOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import {
  defineMethod,
  defineMiddlewareMethod,
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

// ── #705 HALF-2 slice-1 — middleware-slot task binding ──────────────────

/**
 * The cap-tag IDENTIFIER union a declared `middlewares` tuple discharges.
 * (Wraps the tuple in the `{ middlewares }` shape `MiddlewaresOf` reads.)
 */
type CapIdentsFrom<Middlewares extends ReadonlyArray<AnyCapabilityMiddleware>> =
  MiddlewaresOf<{ readonly middlewares: Middlewares }>;

/**
 * The handler + `weaveCaps` shape `defineTaskMiddlewareMethod` accepts.
 *
 * The handler MAY `yield*` the declared caps (`messages/send` reaches
 * `MessageSendPermission` via `messageService.send`) or not (`messages/list`
 * reaches none — its caps are auth side-effects). The TOTALITY guarantee
 * does NOT rest on the handler consuming them (that is the false-green
 * trap); it rests on `weaveCaps`'s WIDENED input requiring ALL declared caps.
 */
interface MiddlewareTaskMethodDef<
  P extends TSchema,
  R extends TSchema,
  K extends "agent" | "app",
  Caps,
  Reqs,
  E,
  EW,
> {
  readonly callablePrincipal: K;
  readonly requiresActive?: boolean;
  readonly handler: (
    params: Static<P>,
    ctx: CtxForKind<K>,
  ) => Effect.Effect<
    Static<R>,
    E,
    Reqs | Caps | CurrentPrincipal | NetworkLayerScope | TaskLayerScope
  >;
  readonly weaveCaps: (
    handlerEffect: Effect.Effect<
      Static<R>,
      E,
      TaskSlotEnv | ConnectionTag | CurrentPrincipal | Caps
    >,
    params: Static<P>,
  ) => Effect.Effect<
    Static<R>,
    EW,
    TaskSlotEnv | ConnectionTag | CurrentPrincipal
  >;
}

/**
 * Task-layer RPC binding via the HALF-2 {@link CapabilityMiddleware} path
 * (principal-as-service + static per-arm cap chain). The cast-free
 * successor to {@link defineTaskMethod} for middleware-converted methods.
 *
 * Pins the slot `Env` to `TaskSlotEnv`, provides `NetworkLayerScope` +
 * `TaskLayerScope` structurally onto the handler, runs the #720 gate +
 * provides `ConnectionTag` and `CurrentPrincipal` (`defineMiddlewareMethod`),
 * and wraps the gated body into an {@link ErasedSlot} via
 * {@link makeMiddlewareSlot} — the SAME slot type a `defineTaskMethod` slot
 * produces, so both store in the SAME `ServerRpcSlotTable` without a widen.
 *
 * **The cast-free TOTALITY lockstep (non-vacuous).** The cap idents are
 * PINNED from the declared `middlewares` tuple via {@link CapIdentsFrom} —
 * NOT inferred from the handler's R (a method whose handler does not itself
 * `yield*` the cap, like `messages/list`, would otherwise pin `never` and
 * the lockstep would go false-green). `weaveCaps`'s input is WIDENED to
 * require every declared cap (sound — providing extra services upward is
 * always assignable), so it MUST discharge EVERY declared cap with a
 * `provideServiceEffect` to bring the woven R down to `TaskSlotEnv |
 * ConnectionTag | CurrentPrincipal` — dropping any leaks that cap into the
 * woven R and fails the bound (TS2322). This is the per-arm coverage gate
 * (cap-reshape §4) replacing the legacy positional `CapProviders` tuple.
 *
 * The discharge is the binding site's hand-expanded `weaveCaps` chain (one
 * `provideServiceEffect` per declared cap, CONCRETE tag, reverse declaration
 * order for Forbidden-before-state-probe) — NO `dischargeCaps` runtime fold,
 * NO `narrowToDispatchContext`, NO `args as Shape`.
 */
export function defineTaskMiddlewareMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends "agent" | "app",
  Middlewares extends ReadonlyArray<AnyCapabilityMiddleware>,
  E,
  EW,
  Reqs extends TaskTags = TaskTags,
>(
  definition: RpcDefinition<Name, P, R>,
  // The declared middleware tuple — the source of truth that PINS the cap
  // idents `weaveCaps` must discharge. Read at the TYPE level only (via
  // `Middlewares`); the runtime weave is `def.weaveCaps`. Pass it `as const`
  // so the tuple shape (hence `CapIdentsFrom`) is preserved. Underscore so
  // the unused-runtime-value lint is satisfied without a `void` statement.
  _middlewares: Middlewares,
  def: MiddlewareTaskMethodDef<
    P,
    R,
    K,
    CapIdentsFrom<Middlewares>,
    Reqs,
    E,
    EW
  >,
): ErasedSlot<TaskSlotEnv, Connection> {
  const body = defineMiddlewareMethod<
    P,
    R,
    K,
    E,
    EW,
    CapIdentsFrom<Middlewares>,
    TaskSlotEnv
  >({
    callablePrincipal: def.callablePrincipal,
    requiresActive: def.requiresActive,
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(
          Effect.provideService(NetworkLayerScope, undefined),
          Effect.provideService(TaskLayerScope, undefined),
        ),
    weaveCaps: def.weaveCaps,
  });
  return makeMiddlewareSlot<Name, P, R, Connection, TaskSlotEnv>(
    definition,
    body,
  );
}
