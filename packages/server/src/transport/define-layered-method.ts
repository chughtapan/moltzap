import { Effect, Schema } from "effect";
import {
  makeMiddlewareSlot,
  type AnyCapabilityMiddleware,
  type CurrentPrincipal,
  type ErasedSlot,
  type MiddlewaresOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import {
  defineMiddlewareMethod,
  defineUnauthMethod,
  type CtxForKind,
  type PrincipalKind,
} from "./context.js";
import type { ConnectionTag } from "../app/layers.js";
import type { Connection } from "./connection.js";
import type { ServerMethodBinding } from "./server-method-bindings.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";
import type { AppTags, NetworkTags, TaskTags } from "./layer-tags.js";

/**
 * The residual `Env` a slot's `invoke` requires from the surrounding
 * `ManagedRuntime` — the layer service tags MINUS `ConnectionTag` (which
 * the slot body provides per-frame from the live arm) and MINUS the
 * per-frame capability tags (discharged inside the slot's woven chain).
 * Each wrapper pins its layer's variant; `Exclude&lt;…, ConnectionTag>` keeps
 * the pin honest so the slot does NOT claim a `ConnectionTag` the runtime
 * never supplies (it is request-scoped).
 */
type NetworkSlotEnv = Exclude<NetworkTags, ConnectionTag>;
type TaskSlotEnv = Exclude<TaskTags, ConnectionTag>;
type AppSlotEnv = Exclude<AppTags, ConnectionTag>;

/**
 * An {@link ErasedSlot} carrying its {@link ServerMethodBinding}. Every wrapper
 * returns one: the `ErasedSlot.invoke` is the live dispatch surface; `binding`
 * surfaces the #720 policy (`callablePrincipal`/`requiresActive`) the wrapper
 * holds in its closure into the single-source registry `makeCoreRpcMethods`
 * assembles.
 */
type BoundSlot<Env> = ErasedSlot<Env, Connection> & {
  readonly binding: ServerMethodBinding;
};

/**
 * Attach the #720 policy the wrapper holds to its slot. The wire `tag` is the
 * descriptor's branded `name`, so the binding tag can never drift from the
 * slot's own method.
 */
const withBinding = <Env>(
  slot: ErasedSlot<Env, Connection>,
  callablePrincipal: PrincipalKind,
  requiresActive: boolean,
): BoundSlot<Env> => ({
  ...slot,
  binding: { tag: slot.definition.name, callablePrincipal, requiresActive },
});

/**
 * The `*LayerScope` marker union each per-layer wrapper provides
 * structurally onto its handler body (the layer-boundary structural lint
 * proof, `layer-boundary.types-check.ts`). Cumulative: a task body may also
 * yield the network scope; an app body may yield all three.
 */
type NetworkScopes = NetworkLayerScope;
type TaskScopes = NetworkLayerScope | TaskLayerScope;
type AppScopes = NetworkLayerScope | TaskLayerScope | AppLayerScope;

/**
 * @file Per-layer RPC binding wrappers — #705 HALF-2 cast-free slot model.
 *
 * Every server RPC binds through the SINGLE {@link CapabilityMiddleware}
 * slot mechanism: the #720 principal-kind gate + the static, hand-expanded
 * `provideServiceEffect` capability chain ({@link defineMiddlewareMethod}),
 * wrapped into an {@link ErasedSlot} via {@link makeMiddlewareSlot}. The
 * pre-HALF-2 `makeErasedSlot` + `dischargeCaps` runtime fold + the positional
 * `CapProviders` tuple + the `argsOf(unknown, unknown)` erasure are all gone;
 * the dispatcher has ONE slot mechanism.
 *
 * Each wrapper composes TWO orthogonal axes onto one slot:
 *   - **Binding layer** — `Reqs extends NetworkTags`/`TaskTags`/`AppTags`
 *     upper bound on the handler body's service-tag R-channel (the wrapper
 *     provides its `*LayerScope` markers structurally).
 *   - **Calling principal** — `callablePrincipal` (`agent`/`app`/`any`)
 *     types the body's `ctx` via `CtxForKind&lt;K>` and drives the #720
 *     principal-kind gate inside the slot body.
 *
 * The wrapper PINS the slot's `Env` to its layer service-tag union (minus the
 * request-scoped `ConnectionTag`) — MANDATORY: a free `Env` would widen to
 * swallow an undeclared capability in the woven R and the totality lockstep
 * goes false-green. The cross-arm totality is the
 * {@link defineMiddlewareMethod} `weaveCaps` bound (the cap idents pinned from
 * the declared `middlewares` tuple via {@link MiddlewaresOf}; canaries in
 * `middleware-slot.types-check.ts`).
 *
 * **Type-alias hierarchy + maintenance contract.** See `./layer-tags.ts`
 * for the allowlist. Adding a new service Tag is a TWO-step edit:
 * update `layer-tags.ts` AND `architectureOptions.layers` in the root
 * `eslint.config.js` so the structural lint and the type system agree.
 */

// ── Capability-tuple → cap-ident union ──────────────────────────────────

/**
 * The cap-tag IDENTIFIER union a declared `middlewares` tuple discharges.
 * (Wraps the tuple in the `{ middlewares }` shape `MiddlewaresOf` reads.)
 */
type CapIdentsFrom<Middlewares extends ReadonlyArray<AnyCapabilityMiddleware>> =
  MiddlewaresOf<{ readonly middlewares: Middlewares }>;

// ── Cap-bearing middleware bindings (per layer) ─────────────────────────

/**
 * The handler + `weaveCaps` shape a per-layer cap-bearing wrapper accepts.
 *
 * The handler MAY `yield*` the declared caps (`messages/send` reaches
 * `MessageSendPermission` via `messageService.send`) or not (`messages/list`
 * reaches none — its caps are auth side-effects). The TOTALITY guarantee
 * does NOT rest on the handler consuming them (the false-green trap); it
 * rests on `weaveCaps`'s WIDENED input requiring ALL declared caps.
 *
 * `SlotEnv` is the wrapper's pinned layer service-tag union; `Scopes` is the
 * `*LayerScope` marker union the wrapper provides structurally onto the body.
 */
interface MiddlewareMethodDef<
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  Caps,
  Reqs,
  Scopes,
  SlotEnv,
  E,
  EW,
> {
  readonly callablePrincipal: K;
  readonly requiresActive?: boolean;
  readonly handler: (
    params: Schema.Schema.Type<P>,
    ctx: CtxForKind<K>,
  ) => Effect.Effect<
    Schema.Schema.Type<R>,
    E,
    Reqs | Caps | CurrentPrincipal | Scopes
  >;
  readonly weaveCaps: (
    handlerEffect: Effect.Effect<
      Schema.Schema.Type<R>,
      E,
      SlotEnv | ConnectionTag | CurrentPrincipal | Caps
    >,
    params: Schema.Schema.Type<P>,
  ) => Effect.Effect<
    Schema.Schema.Type<R>,
    EW,
    SlotEnv | ConnectionTag | CurrentPrincipal
  >;
}

/**
 * The structural `*LayerScope`-discharge step a per-layer wrapper hands
 * {@link buildMiddlewareSlot}. It takes the handler effect (which may yield
 * the layer scopes + caps) and provides the layer's scope markers, bringing
 * the R down to the slot's `SlotEnv | ConnectionTag | CurrentPrincipal |
 * Caps` (the caps + principal are subtracted later by the slot body).
 */
type ScopeProvider<
  R extends Schema.Schema.AnyNoContext,
  Reqs,
  Caps,
  Scopes,
  SlotEnv,
  E,
> = (
  e: Effect.Effect<
    Schema.Schema.Type<R>,
    E,
    Reqs | Caps | CurrentPrincipal | Scopes
  >,
) => Effect.Effect<
  Schema.Schema.Type<R>,
  E,
  SlotEnv | ConnectionTag | CurrentPrincipal | Caps
>;

/**
 * Build a cap-bearing middleware slot for one layer. The shared core of the
 * three per-layer wrappers: it runs {@link defineMiddlewareMethod} (the #720
 * gate + the binding-site `weaveCaps` cap chain + the `CurrentPrincipal` /
 * `ConnectionTag` provisions), provides the layer's `*LayerScope` markers
 * structurally onto the handler, and wraps the gated body into an
 * {@link ErasedSlot} via {@link makeMiddlewareSlot}.
 *
 * **The cast-free TOTALITY lockstep (non-vacuous).** The cap idents are
 * PINNED from the declared `middlewares` tuple via {@link CapIdentsFrom} —
 * NOT inferred from the handler's R (a method whose handler does not itself
 * `yield*` the cap, like `messages/list`, would otherwise pin `never` and the
 * lockstep would go false-green). `weaveCaps`'s input is WIDENED to require
 * every declared cap (sound — providing extra services upward is always
 * assignable), so it MUST discharge EVERY declared cap with a
 * `provideServiceEffect` to bring the woven R down to `SlotEnv |
 * ConnectionTag | CurrentPrincipal` — dropping any leaks that cap into the
 * woven R and fails the bound (TS2322).
 */
function buildMiddlewareSlot<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  Middlewares extends ReadonlyArray<AnyCapabilityMiddleware>,
  Scopes,
  SlotEnv,
  E,
  EW,
  Reqs,
>(
  definition: RpcDefinition<Name, P, R>,
  def: MiddlewareMethodDef<
    P,
    R,
    K,
    CapIdentsFrom<Middlewares>,
    Reqs,
    Scopes,
    SlotEnv,
    E,
    EW
  >,
  provideScopes: ScopeProvider<
    R,
    Reqs,
    CapIdentsFrom<Middlewares>,
    Scopes,
    SlotEnv,
    E
  >,
): BoundSlot<SlotEnv> {
  // prettier-ignore
  const body = defineMiddlewareMethod<P, R, K, E, EW, CapIdentsFrom<Middlewares>, SlotEnv>({
    callablePrincipal: def.callablePrincipal,
    requiresActive: def.requiresActive,
    handler: (params, ctx) => provideScopes(def.handler(params, ctx)),
    weaveCaps: def.weaveCaps,
  });
  const slot = makeMiddlewareSlot<Name, P, R, Connection, SlotEnv>(
    definition,
    body,
  );
  return withBinding(slot, def.callablePrincipal, def.requiresActive ?? false);
}

/**
 * Network-layer cap-bearing binding. Handler `R`-channel is
 * `Reqs extends NetworkTags`; provides `NetworkLayerScope` structurally.
 * Internal — the cap-less {@link defineNetworkMethod} delegates here; no
 * network method bears capabilities today, so there is no external consumer.
 */
function defineNetworkMiddlewareMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  Middlewares extends ReadonlyArray<AnyCapabilityMiddleware>,
  E,
  EW,
  Reqs extends NetworkTags = NetworkTags,
>(
  definition: RpcDefinition<Name, P, R>,
  _middlewares: Middlewares,
  def: MiddlewareMethodDef<
    P,
    R,
    K,
    CapIdentsFrom<Middlewares>,
    Reqs,
    NetworkScopes,
    NetworkSlotEnv,
    E,
    EW
  >,
): BoundSlot<NetworkSlotEnv> {
  return buildMiddlewareSlot<
    Name,
    P,
    R,
    K,
    Middlewares,
    NetworkScopes,
    NetworkSlotEnv,
    E,
    EW,
    Reqs
  >(definition, def, (e) =>
    e.pipe(Effect.provideService(NetworkLayerScope, undefined)),
  );
}

/**
 * Task-layer cap-bearing binding. Handler `R`-channel is `Reqs extends
 * TaskTags`; provides `NetworkLayerScope` + `TaskLayerScope` structurally.
 */
export function defineTaskMiddlewareMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
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
  def: MiddlewareMethodDef<
    P,
    R,
    K,
    CapIdentsFrom<Middlewares>,
    Reqs,
    TaskScopes,
    TaskSlotEnv,
    E,
    EW
  >,
): BoundSlot<TaskSlotEnv> {
  return buildMiddlewareSlot<
    Name,
    P,
    R,
    K,
    Middlewares,
    TaskScopes,
    TaskSlotEnv,
    E,
    EW,
    Reqs
  >(definition, def, (e) =>
    e.pipe(
      Effect.provideService(NetworkLayerScope, undefined),
      Effect.provideService(TaskLayerScope, undefined),
    ),
  );
}

/**
 * App-layer cap-bearing binding. Handler `R`-channel is `Reqs extends
 * AppTags`; provides all three layer scopes structurally.
 */
export function defineAppMiddlewareMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  Middlewares extends ReadonlyArray<AnyCapabilityMiddleware>,
  E,
  EW,
  Reqs extends AppTags = AppTags,
>(
  definition: RpcDefinition<Name, P, R>,
  _middlewares: Middlewares,
  def: MiddlewareMethodDef<
    P,
    R,
    K,
    CapIdentsFrom<Middlewares>,
    Reqs,
    AppScopes,
    AppSlotEnv,
    E,
    EW
  >,
): BoundSlot<AppSlotEnv> {
  return buildMiddlewareSlot<
    Name,
    P,
    R,
    K,
    Middlewares,
    AppScopes,
    AppSlotEnv,
    E,
    EW,
    Reqs
  >(definition, def, (e) =>
    e.pipe(
      Effect.provideService(NetworkLayerScope, undefined),
      Effect.provideService(TaskLayerScope, undefined),
      Effect.provideService(AppLayerScope, undefined),
    ),
  );
}

// ── Cap-LESS convenience bindings (per layer) ───────────────────────────

/**
 * The handler shape a cap-LESS per-layer wrapper accepts. No `weaveCaps` (no
 * caps to weave): the slot body runs the #720 gate, provides `ConnectionTag`
 * + `CurrentPrincipal`, and runs the handler. The cast-free successor to the
 * deleted `defineXMethod` + `makeErasedSlot` cap-less agent/app path.
 */
interface CaplessMethodDef<
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  Reqs,
  Scopes,
  E,
> {
  readonly callablePrincipal: K;
  readonly requiresActive?: boolean;
  readonly handler: (
    params: Schema.Schema.Type<P>,
    ctx: CtxForKind<K>,
  ) => Effect.Effect<
    Schema.Schema.Type<R>,
    E,
    Reqs | CurrentPrincipal | Scopes
  >;
}

/**
 * Network-layer cap-LESS binding. `Reqs extends NetworkTags`.
 */
export function defineNetworkMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  E = never,
  Reqs extends NetworkTags = NetworkTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: CaplessMethodDef<P, R, K, Reqs, NetworkScopes, E>,
): BoundSlot<NetworkSlotEnv> {
  return defineNetworkMiddlewareMethod<Name, P, R, K, readonly [], E, E, Reqs>(
    definition,
    [],
    {
      callablePrincipal: def.callablePrincipal,
      requiresActive: def.requiresActive,
      handler: def.handler,
      weaveCaps: (e) => e,
    },
  );
}

/**
 * Task-layer cap-LESS binding. `Reqs extends TaskTags`.
 */
export function defineTaskMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  E = never,
  Reqs extends TaskTags = TaskTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: CaplessMethodDef<P, R, K, Reqs, TaskScopes, E>,
): BoundSlot<TaskSlotEnv> {
  return defineTaskMiddlewareMethod<Name, P, R, K, readonly [], E, E, Reqs>(
    definition,
    [],
    {
      callablePrincipal: def.callablePrincipal,
      requiresActive: def.requiresActive,
      handler: def.handler,
      weaveCaps: (e) => e,
    },
  );
}

/**
 * App-layer cap-LESS binding. `Reqs extends AppTags`.
 */
export function defineAppMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends "agent" | "app",
  E = never,
  Reqs extends AppTags = AppTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: CaplessMethodDef<P, R, K, Reqs, AppScopes, E>,
): BoundSlot<AppSlotEnv> {
  return defineAppMiddlewareMethod<Name, P, R, K, readonly [], E, E, Reqs>(
    definition,
    [],
    {
      callablePrincipal: def.callablePrincipal,
      requiresActive: def.requiresActive,
      handler: def.handler,
      weaveCaps: (e) => e,
    },
  );
}

// ── Unauthenticated binding (network/connect) ───────────────────────────

/**
 * The lone `"any"`-principal binding — `network/connect` (#705 #720). It is
 * dispatched while the arm is still `UnauthenticatedConnection`, so there is
 * NO principal `ctx`; the body dispatches on the credential union itself,
 * reading the live arm via `ConnectionTag`. Bound at the APP layer (its
 * `appKey` arm pulls `AppHostTag`). Runs through {@link defineUnauthMethod},
 * which provides `ConnectionTag` only — `CurrentPrincipal` is never provided
 * on the unauthenticated arm.
 */
export function defineConnectMethod<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  E = never,
  Reqs extends AppTags = AppTags,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    readonly handler: (
      params: Schema.Schema.Type<P>,
      ctx: undefined,
    ) => Effect.Effect<Schema.Schema.Type<R>, E, Reqs | AppScopes>;
  },
): BoundSlot<AppSlotEnv> {
  const body = defineUnauthMethod<P, R, E, AppSlotEnv>({
    handler: (params, ctx) =>
      def
        .handler(params, ctx)
        .pipe(
          Effect.provideService(NetworkLayerScope, undefined),
          Effect.provideService(TaskLayerScope, undefined),
          Effect.provideService(AppLayerScope, undefined),
        ),
  });
  const slot = makeMiddlewareSlot<Name, P, R, Connection, AppSlotEnv>(
    definition,
    body,
  );
  return withBinding(slot, "any", false);
}
