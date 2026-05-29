import { Context, Data, Effect } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  ForbiddenError,
  type HandlerSlot,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import type { AppId } from "@moltzap/protocol/task";
import { ConnectionTag } from "../app/layers.js";
import type { MoltZapConnection } from "./connection.js";
import type { AgentId, UserId } from "../app/types.js";

export interface AuthenticatedContext {
  agentId: AgentId;
  agentStatus: string;
  ownerUserId: UserId | null;
}

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
 * once the three-arm `Connection` union (`transport/connection.ts`) lands.
 * No `AuthenticatedContext`-style wrapper sits above them — the bare union
 * `AgentContext | AppContext` is the principal type.
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
 * D #705 CP4a — narrow the legacy `AuthenticatedContext` (carrying
 * `agentStatus: string`) to the closed-union `AgentContext` arm used by the
 * three-arm `connectionsRef`. The `agent_status` SQL enum constrains the
 * stored value to exactly the {@link AgentStatus} members, so a value outside
 * the union is an impossible-state defect (`Effect.die`), not a
 * caller-actionable error.
 *
 * Transitional: deleted at the CP4 cutover once the Connect path mints the
 * `AgentContext` arm directly (no `AuthenticatedContext` intermediary).
 */
export function agentContextFromAuthenticated(
  auth: AuthenticatedContext,
): Effect.Effect<AgentContext> {
  return narrowAgentStatus(auth.agentStatus).pipe(
    Effect.map(
      (agentStatus) =>
        new AgentContext({
          agentId: auth.agentId,
          agentStatus,
          ownerUserId: auth.ownerUserId,
        }),
    ),
  );
}

function narrowAgentStatus(status: string): Effect.Effect<AgentStatus> {
  switch (status) {
    case "active":
    case "pending_claim":
    case "suspended":
      return Effect.succeed(status);
    default:
      return Effect.die(
        new Error(
          `agentContextFromAuthenticated: agent_status outside closed union: ${status}`,
        ),
      );
  }
}

/** Per-request dispatch context handed to every RPC handler by the typed dispatcher. */
export interface DispatchContext {
  readonly auth: AuthenticatedContext;
  readonly connection: MoltZapConnection;
}

/**
 * RPC binding stored in the registry. Each binding carries a method
 * definition and a Spec F (#617) typed-dispatcher `HandlerSlot`-shaped
 * handler that already provides `ConnectionTag` from the dispatch context.
 *
 * The remaining R-channel tags (the rest of `AppTags`) are provided by
 * the dispatcher's `FullLive` Layer at request time via the surrounding
 * `ManagedRuntime`. At the slot type the R-channel is widened to a
 * generic `Context.Tag` union for storage; the runtime resolves R
 * against `FullLive` post-`asNeverR` in
 * `transport/dispatch.ts → makeInboundDispatch`.
 */
export type RpcMethodBinding = HandlerSlot<
  RpcDefinition<string, TSchema, TSchema>,
  DispatchContext,
  Context.Tag<unknown, unknown>
>;

export type RpcMethodRegistry = RpcMethodBinding[];

/**
 * Type-safe RPC method definition driven by a protocol manifest.
 * Wraps the user's handler with `requiresActive` enforcement and
 * provides `ConnectionTag` from the dispatch context.
 *
 * `Reqs` is the handler body's R-channel — the union of service Tags it
 * `yield*`s plus `ConnectionTag` if the body reads it. Defaults to
 * `ConnectionTag` so existing handlers (which yield no service Tags)
 * continue to compile against this signature. Per the Phase 2A r2 plan
 * §3, the `defineXMethod` variants in `define-layered-method.ts` add
 * per-layer upper bounds on `Reqs` via constrained generics; this base
 * `defineMethod` is unconstrained.
 *
 * `Effect.provideService(ConnectionTag, ctx.connId)` is a no-op when the
 * body doesn't pull `ConnectionTag` (the `R` channel of `Effect` excludes
 * the tag if absent), so `Reqs` widening doesn't lie about
 * requirements.
 */
export function defineMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
  // `Reqs` is intentionally unconstrained: caller handlers' R-channels
  // are unions of concrete `Context.Tag` instances (DbTag, etc.) whose
  // invariant `Id`/`Type` parameters reject the `Context.Tag<unknown,
  // unknown>` upper bound. The dispatcher's `asNeverR` erases R at the
  // runtime boundary; the surrounding `ManagedRuntime` provides the
  // tags via `FullLive`.
  Reqs = never,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    handler: (
      params: Static<P>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<R>, E, Reqs | ConnectionTag>;
    requiresActive?: boolean;
  },
): RpcMethodBinding {
  const requiresActive = def.requiresActive ?? false;
  // Spec F (#617) typed-dispatcher binding: construct a `HandlerSlot`
  // literal directly. The dispatcher's `makeInboundDispatch` runs each
  // slot's `handle` inside the surrounding `ManagedRuntime` whose
  // `FullLive` layer provides every Tag the handler `yield*`s. The
  // erasure-to-`never` happens in `dispatch.ts → asNeverR` at the
  // dispatcher boundary.
  const slotHandle = (params: Static<P>, ctx: DispatchContext) =>
    Effect.gen(function* () {
      if (requiresActive && ctx.auth.agentStatus !== "active") {
        return yield* Effect.fail(
          new ForbiddenError({
            message: "Agent must be claimed before performing this action",
          }),
        );
      }
      // The handler returns `Static<R>`; the conditional `ResultOf<D>`
      // reduces to that, but TypeScript doesn't auto-simplify across
      // the generic boundary, so the cast bridges the equality.
      //
      // R-channel: `def.handler` returns
      // `Effect<Static<R>, E, Reqs | ConnectionTag>`.
      // `Effect.provideService(ConnectionTag, ctx.connId)` removes ConnectionTag;
      // remaining Reqs ride through into the `HandlerSlot.handle` R
      // channel and are resolved by the dispatcher's `ManagedRuntime` at
      // request time.
      const result = yield* def
        .handler(params, ctx.auth)
        .pipe(Effect.provideService(ConnectionTag, ctx.connection));
      return result as ResultOf<RpcDefinition<Name, P, R>>;
    }).pipe(Effect.withSpan("defineMethod"));
  return {
    definition,
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- HandlerSlot.handle's params type narrows to `ParamsOf<D>` (= `Static<P>` post-decode); the dispatcher passes the AJV-narrowed value, so the erasure-via-binding is safe (Spec F §3 carve-out).
    handle: slotHandle as unknown as RpcMethodBinding["handle"], // #ignore-sloppy-code[as-unknown-as]: HandlerSlot.handle's params type narrows to `ParamsOf<D>` post-decode; the dispatcher's AJV-narrowed value satisfies the constraint at runtime (Spec F §3 carve-out)
  };
}
