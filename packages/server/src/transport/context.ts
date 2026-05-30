import { Data, Effect, type Exit } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  ForbiddenError,
  CurrentPrincipal,
  type ErasedSlot,
  type ErasedSlotTable,
  type RpcDefinition,
} from "@moltzap/protocol";
import type { AppId } from "@moltzap/protocol/task";
import { ConnectionTag } from "../app/layers.js";
import type { Connection } from "./connection.js";
import type { AppTags } from "./layer-tags.js";
import type { AgentId, UserId } from "../app/types.js";

/**
 * Closed agent lifecycle states. Mirrors
 * `core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
 * union makes `requiresActive` checks exhaustive — adding a state forces
 * every consumer switch to handle it.
 */
export type AgentStatus = "active" | "pending_claim" | "suspended";

/**
 * The two tagged principal arms (D #705 §1.1). These are the only
 * "context" classes; a connection's principal is reached via `conn.auth`
 * off the three-arm `Connection` union (`transport/connection.ts`). No
 * `AuthenticatedContext`-style wrapper sits above them — the bare union
 * `AgentContext | AppContext` is the principal type, minted directly on the
 * Connect path. Handlers receive their NARROWED arm
 * ({@link AgentContext} for agent-callable RPCs, {@link AppContext} for
 * app-callable), keyed by each binding's {@link PrincipalKind}.
 */
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId | null;
}> {}

export class AppContext extends Data.TaggedClass("AppContext")<{
  readonly appId: AppId;
}> {}

/**
 * D #705 — mint the closed-union {@link AgentContext} arm DIRECTLY from the
 * raw fields an authenticator resolves (the Connect path's sole minting site;
 * there is no `AuthenticatedContext` intermediary). The `agent_status` SQL
 * enum (`core-schema.sql → CREATE TYPE agent_status`) constrains the stored
 * value to exactly the {@link AgentStatus} members, but the DB driver types it
 * as `string`, so a value outside the union is an impossible-state defect
 * (`Effect.die`), not a caller-actionable error.
 */
export function agentContextFrom(parts: {
  readonly agentId: AgentId;
  readonly agentStatus: string;
  readonly ownerUserId: UserId | null;
}): Effect.Effect<AgentContext> {
  switch (parts.agentStatus) {
    case "active":
    case "pending_claim":
    case "suspended":
      return Effect.succeed(
        new AgentContext({
          agentId: parts.agentId,
          agentStatus: parts.agentStatus,
          ownerUserId: parts.ownerUserId,
        }),
      );
    default:
      return Effect.die(
        new Error(
          `agentContextFrom: agent_status outside closed union: ${parts.agentStatus}`,
        ),
      );
  }
}

/**
 * #705 #720 — the calling-principal axis. Orthogonal to the binding layer
 * (`defineNetworkMethod`/`defineTaskMethod`/`defineAppMethod`, which own the
 * R-channel Tag bound): a `defineAppMethod`-bound RPC may still declare
 * `callablePrincipal: "agent"` (e.g. `task/request`, `dispatch/request` — they
 * `yield* AppHostTag` yet read `ctx.agentId`).
 */
export type PrincipalKind = "agent" | "app" | "any";

/**
 * #705 #720 §B1 — the value→type binding that makes wrong-principal wiring a
 * COMPILE error. The handler's `ctx` type is a function of the binding's
 * declared `callablePrincipal` VALUE: an `"agent"` binding hands the body an
 * {@link AgentContext}; reading `ctx.appId` then fails TS2339, and passing an
 * `(ctx: AppContext)` lambda fails TS2345. `principal.types-check.ts` already
 * proves the two arms disjoint; the gate leans on that disjointness at the
 * binding site. `"any"` (only `network/connect`, dispatched while the arm is
 * still unauthenticated) gets no principal `ctx` — it reads the live arm via
 * `ConnectionTag` — so its `ctx` is `undefined`.
 */
export type CtxForKind<K extends PrincipalKind> = K extends "agent"
  ? AgentContext
  : K extends "app"
    ? AppContext
    : undefined;

/**
 * Per-request dispatch context handed to the dispatcher boundary (D #705
 * CP4d). The SERVER `DispatchContext` carries the live THREE-arm `Connection`
 * union — the principal (`arm.auth`) and the connId are reached off the arm.
 * It is the dispatcher `Ctx` instantiation (the `ServerConnection` Ctx param),
 * and it is the only type that accepts the UNAUTHENTICATED arm, which the
 * Connect frame needs (`socket-handler.ts → handleRequestFrame` passes the
 * unnarrowed arm). It does NOT structurally satisfy the protocol-owned
 * `DispatchContext` (`@moltzap/protocol` `capabilities.ts`): that type requires
 * `connection.auth`, and `UnauthenticatedConnection` has none. Only the
 * NARROWED agent/app arms are assignable to the protocol type — which is
 * exactly why `argsOf` may require `auth` while this dispatcher `Ctx` may not
 * ("two names, one per role").
 */
interface DispatchContext {
  readonly connection: Connection;
}

/**
 * One server-side inbound RPC slot — #705 HALF-1. Every `defineXMethod`
 * wrapper returns an `ErasedSlot` whose residual `Env` is its layer tag
 * union MINUS `ConnectionTag` (provided per-frame inside `defineMethod`
 * from the live arm) and minus the per-frame capability tags (discharged
 * inside the slot). The widest layer is `AppTags` (`AppTags ⊇ TaskTags ⊇
 * NetworkTags`), and Effect's `R` channel is covariant, so a
 * narrower-`Env` slot assigns up to `ServerRpcSlot`. `Conn` is the
 * server's three-arm {@link Connection}.
 */
type ServerRpcSlot = ErasedSlot<Exclude<AppTags, ConnectionTag>, Connection>;

/**
 * A per-handler-file slice of the server's inbound catalog. Each
 * `*.handlers.ts` exports one of these; `app/server.ts → makeCoreRpcMethods`
 * concatenates them and `buildServerSlots` keys them by `definition.name`
 * into the {@link ServerRpcSlotTable} `makeServerConnection` consumes.
 */
export type ServerRpcSlots = ReadonlyArray<ServerRpcSlot>;

/** The keyed slot table the server dispatcher indexes by `frame.method`. */
export type ServerRpcSlotTable = ErasedSlotTable<
  Exclude<AppTags, ConnectionTag>,
  Connection
>;

const FORBIDDEN_AGENT_ONLY =
  "This method is callable only by an agent principal";
const FORBIDDEN_APP_ONLY = "This method is callable only by an app principal";
const FORBIDDEN_INACTIVE =
  "Agent must be claimed before performing this action";

/**
 * Narrow the live arm to the agent principal (#705 #720 §B1). Rejects a
 * non-agent arm and (when `requiresActive`) a not-yet-claimed agent.
 */
function narrowAgentArm(
  connection: Connection,
  requiresActive: boolean,
): Effect.Effect<AgentContext, ForbiddenError> {
  if (connection._tag !== "AgentConnection") {
    return Effect.fail(new ForbiddenError({ message: FORBIDDEN_AGENT_ONLY }));
  }
  if (requiresActive && connection.auth.agentStatus !== "active") {
    return Effect.fail(new ForbiddenError({ message: FORBIDDEN_INACTIVE }));
  }
  return Effect.succeed(connection.auth);
}

/** Narrow the live arm to the app principal (#705 #720 §B1). */
function narrowAppArm(
  connection: Connection,
): Effect.Effect<AppContext, ForbiddenError> {
  return connection._tag === "AppConnection"
    ? Effect.succeed(connection.auth)
    : Effect.fail(new ForbiddenError({ message: FORBIDDEN_APP_ONLY }));
}

/**
 * Apply the principal-kind gate (runtime half, #705 #720 §B1). Narrows the
 * live `Connection` arm to the binding's declared `callablePrincipal` and
 * yields the body's real `CtxForKind` arm. A wrong-principal frame is rejected
 * with a clean `ForbiddenError` BEFORE the body runs (the irreducible
 * dynamic-wire residue). For `"any"` (only `network/connect`, dispatched while
 * the arm is still unauthenticated) the body reads the arm via `ConnectionTag`,
 * not `ctx`, so `undefined` is handed in. The runtime narrowing and the
 * compile-time `ctx` type are the SAME arm by construction.
 */
function narrowPrincipalCtx<K extends PrincipalKind>(
  callablePrincipal: K,
  connection: Connection,
  requiresActive: boolean,
): Effect.Effect<CtxForKind<K>, ForbiddenError> {
  let narrowed: Effect.Effect<
    AgentContext | AppContext | undefined,
    ForbiddenError
  >;
  if (callablePrincipal === "agent") {
    narrowed = narrowAgentArm(connection, requiresActive);
  } else if (callablePrincipal === "app") {
    narrowed = narrowAppArm(connection);
  } else {
    narrowed = Effect.succeed(undefined);
  }
  return narrowed as Effect.Effect<CtxForKind<K>, ForbiddenError>;
}

/**
 * The slot-handler shape `defineMethod` produces — #705 HALF-1. The
 * `defineXMethod` wrappers (`define-layered-method.ts`) feed this to
 * `makeErasedSlot` as the slot's typed `handler`. `ctx` is the
 * dispatcher-boundary {@link DispatchContext} (the 3-arm `Connection`);
 * the wrapper pins `makeErasedSlot`'s `Conn = Connection`, so
 * `SlotDispatchContext&lt;Connection>` IS this `{ connection: Connection }`.
 *
 * The handler RETURNS the #720-gated body: `narrowPrincipalCtx` rejects a
 * wrong-principal arm with `ForbiddenError` BEFORE the body runs (so the
 * `ForbiddenError` rides the error channel), then runs the user handler
 * on the NARROWED arm and provides `ConnectionTag` from the live arm.
 * The residual `R` is `Reqs` (the layer service tags + per-frame
 * capability tags) the dispatcher's `ManagedRuntime` / the slot's own
 * capability discharge resolves.
 */
export type SlotHandler<P extends TSchema, R extends TSchema, E, Reqs> = (
  params: Static<P>,
  ctx: DispatchContext,
) => Effect.Effect<Static<R>, E | ForbiddenError, Reqs>;

/**
 * Type-safe RPC method definition driven by a protocol manifest.
 * Wraps the user's handler with the #705 #720 §B1 principal-kind gate
 * (`narrowPrincipalCtx`) + `requiresActive` enforcement and provides
 * `ConnectionTag` from the dispatch context. Returns the gated
 * {@link SlotHandler} the `defineXMethod` wrappers thread into
 * `makeErasedSlot` (no longer an `RpcMethodBinding` — the registry shape
 * was retired by the cast-free `ErasedSlotTable` cutover).
 *
 * `Reqs` is the handler body's R-channel — the union of service Tags it
 * `yield*`s (plus per-frame capability tags) MINUS `ConnectionTag`
 * (provided here from the live arm). Per the Phase 2A r2 plan §3, the
 * `defineXMethod` variants add per-layer upper bounds on `Reqs` via
 * constrained generics; this base `defineMethod` is unconstrained.
 *
 * `Effect.provideService(ConnectionTag, ctx.connection)` is a no-op when
 * the body doesn't pull `ConnectionTag`, so `Reqs` widening doesn't lie
 * about requirements.
 */
export function defineMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  K extends PrincipalKind,
  E = never,
  // `Reqs` is intentionally unconstrained: caller handlers' R-channels
  // are unions of concrete `Context.Tag` instances (DbTag, etc.) whose
  // invariant `Id`/`Type` parameters reject a `Context.Tag<unknown,
  // unknown>` upper bound. The slot's `makeErasedSlot` `Env`-pin + the
  // surrounding `ManagedRuntime` (`FullLive`) resolve them at request
  // time; the per-frame capability tags are discharged inside the slot.
  Reqs = never,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    // #705 #720 §B1 — REQUIRED, no default. Omitting it is TS2554; it is the
    // value that types `ctx` via `CtxForKind<K>` (the value→type binding).
    readonly callablePrincipal: K;
    readonly handler: (
      params: Static<P>,
      ctx: CtxForKind<K>,
    ) => Effect.Effect<Static<R>, E, Reqs | ConnectionTag>;
    readonly requiresActive?: boolean;
  },
  // `ConnectionTag` is provided per-frame from the live arm below, so it
  // is SUBTRACTED from the gated handler's residual R — the slot does NOT
  // claim a request-scoped `ConnectionTag` from the `ManagedRuntime`.
): SlotHandler<P, R, E, Exclude<Reqs, ConnectionTag>> {
  const requiresActive = def.requiresActive ?? false;
  const callablePrincipal = def.callablePrincipal;
  // #705 HALF-1 — the gated slot handler. The `defineXMethod` wrapper
  // threads this into `makeErasedSlot`; the slot's `invoke` runs it on
  // the dispatcher-supplied `DispatchContext` (the 3-arm `Connection`).
  // `narrowPrincipalCtx` is the #720 principal gate's INVOKE PRE-BODY:
  // it rejects a wrong-principal arm with `ForbiddenError` before the
  // user body runs, then hands the body its narrowed `CtxForKind<K>` arm.
  return (params: Static<P>, ctx: DispatchContext) =>
    Effect.gen(function* () {
      const principalCtx = yield* narrowPrincipalCtx(
        callablePrincipal,
        ctx.connection,
        requiresActive,
      );
      // R-channel: `def.handler` returns
      // `Effect<Static<R>, E, Reqs | ConnectionTag>`.
      // `Effect.provideService(ConnectionTag, ctx.connection)` removes
      // ConnectionTag; remaining `Reqs` ride out for the slot's
      // capability discharge + the dispatcher's `ManagedRuntime`.
      return yield* def
        .handler(params, principalCtx)
        .pipe(Effect.provideService(ConnectionTag, ctx.connection));
    }).pipe(Effect.withSpan("defineMethod"));
}

/**
 * The handler + `weaveCaps` shape {@link defineMiddlewareMethod} accepts.
 *
 * `NoInfer&lt;CapIdents>` on the handler: `CapIdents` is PINNED by the caller
 * (`defineTaskMiddlewareMethod` derives it from the declared middleware
 * tuple). Without `NoInfer`, a handler whose body does not `yield*` the cap
 * would let TS infer `CapIdents = never` and the `weaveCaps` totality
 * lockstep would go false-green. The handler effect is widened to require
 * `CapIdents` (sound — providing extra services upward is assignable) so
 * `weaveCaps` MUST discharge every pinned cap. `weaveCaps` subtracts the
 * cap idents (`provideServiceEffect` per CONCRETE tag) and may add obtain
 * errors (`EW ⊇ E`); `CurrentPrincipal` / `ConnectionTag` stay in its
 * output R and are subtracted by the body's two `provideService`s.
 */
interface MiddlewareMethodDef<
  P extends TSchema,
  R extends TSchema,
  K extends "agent" | "app",
  E,
  EW,
  CapIdents,
  Env,
> {
  readonly callablePrincipal: K;
  readonly requiresActive?: boolean;
  readonly handler: (
    params: Static<P>,
    ctx: CtxForKind<K>,
  ) => Effect.Effect<
    Static<R>,
    E,
    Env | ConnectionTag | CurrentPrincipal | NoInfer<CapIdents>
  >;
  readonly weaveCaps: (
    handlerEffect: Effect.Effect<
      Static<R>,
      E,
      Env | ConnectionTag | CurrentPrincipal | CapIdents
    >,
    params: Static<P>,
  ) => Effect.Effect<Static<R>, EW, Env | ConnectionTag | CurrentPrincipal>;
}

/**
 * Compose ONE cast-free middleware-slot body (#705 HALF-2 slice-1). The
 * principal-as-service successor to {@link defineMethod} + the legacy slot's
 * `dischargeCaps` runtime fold. It:
 *   1. runs the #720 principal-kind gate (`narrowPrincipalCtx`) → the
 *      narrowed `AgentContext | AppContext` arm (a {@link Principal});
 *   2. lets the binding site weave the method's STATIC, hand-expanded
 *      capability `provideServiceEffect` chain over the handler effect
 *      (`weaveCaps` — each names a CONCRETE tag, so R subtracts cast-free);
 *   3. provides `ConnectionTag` from the live arm AND `CurrentPrincipal`
 *      from the narrowed arm — the principal-as-service provision site
 *      (`derivePayload` reads `CurrentPrincipal` via `yield*`; this provide
 *      SUBTRACTS it; the residual R bottoms out at `Env`);
 *   4. `Effect.exit`s into the inner `Exit` the dispatcher projects.
 *
 * `K extends "agent" | "app"` (NOT `"any"`): every cap-bearing method is
 * authenticated, so the narrowed arm is always a real `Principal`. The
 * unauth Connect path (`"any"`) declares no middlewares and never reaches
 * here — so `CurrentPrincipal` is never provided on the unauthenticated arm
 * (the #720 gate rejected non-agent/app callers BEFORE any principal read).
 *
 * Cast-free end to end: NO `dischargeCaps` runtime fold, NO
 * `narrowToDispatchContext`, NO `argsOf(unknown, unknown)` erasure, NO
 * per-provider `args as Shape`.
 */
export function defineMiddlewareMethod<
  P extends TSchema,
  R extends TSchema,
  K extends "agent" | "app",
  E,
  EW,
  CapIdents,
  Env,
>(
  def: MiddlewareMethodDef<P, R, K, E, EW, CapIdents, Env>,
): (
  params: Static<P>,
  ctx: DispatchContext,
) => Effect.Effect<Exit.Exit<unknown, unknown>, never, Env> {
  const requiresActive = def.requiresActive ?? false;
  const callablePrincipal = def.callablePrincipal;
  return (params: Static<P>, ctx: DispatchContext) =>
    // `Effect.exit` over the WHOLE body so the #720 gate's `ForbiddenError`
    // (a wrong-principal arm) ALSO surfaces as a success-typed `Exit.Failure`
    // the dispatcher projects (mirrors `makeErasedSlot.invoke`). The gate
    // runs BEFORE any `CurrentPrincipal` read — the unauth/wrong-principal
    // arm is rejected before the principal-as-service provision (#720).
    Effect.gen(function* () {
      const principalCtx = yield* narrowPrincipalCtx(
        callablePrincipal,
        ctx.connection,
        requiresActive,
      );
      return yield* def
        .weaveCaps(def.handler(params, principalCtx), params)
        .pipe(
          Effect.provideService(ConnectionTag, ctx.connection),
          // The principal-as-service provision: `derivePayload` reads the
          // caller's id via `yield* CurrentPrincipal`; this concrete-value
          // provide subtracts `CurrentPrincipal` from the woven R. The
          // narrowed `AgentContext | AppContext` arm structurally inhabits
          // the protocol `Principal` (extra fields are fine for a
          // read-only consumer), so NO cast.
          Effect.provideService(CurrentPrincipal, principalCtx),
        );
    }).pipe(Effect.exit, Effect.withSpan("defineMiddlewareMethod"));
}
