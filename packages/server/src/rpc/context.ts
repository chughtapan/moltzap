import { Effect } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  ForbiddenError,
  handler,
  type ResultOf,
  type RpcDefinition,
  type RpcHandler,
} from "@moltzap/protocol";
import { ConnIdTag } from "../app/layers.js";
import type { AgentId, UserId } from "../app/types.js";

export interface AuthenticatedContext {
  agentId: AgentId;
  agentStatus: string;
  ownerUserId: UserId | null;
}

/** Per-request dispatch context handed to every RPC handler by JsonRpcServer. */
export interface DispatchContext {
  readonly auth: AuthenticatedContext;
  readonly connId: string;
}

/** RPC binding stored in the registry. Each binding carries a method
 * definition and a `JsonRpcServer`-compatible handler that already
 * provides the layer scopes + ConnIdTag service. */
export type RpcMethodBinding = RpcHandler<DispatchContext>;

export type RpcMethodRegistry = RpcMethodBinding[];

/** Type-safe RPC method definition driven by a protocol manifest.
 * Wraps the user's handler with `requiresActive` enforcement and
 * provides `ConnIdTag` from the dispatch context.
 *
 * `Reqs` is the handler body's R-channel — the union of service Tags it
 * `yield*`s plus `ConnIdTag` if the body reads it. Defaults to
 * `ConnIdTag` so existing handlers (which yield no service Tags)
 * continue to compile against this signature. Per the Phase 2A r2 plan
 * §3, the `defineXMethod` variants in `define-layered-method.ts` add
 * per-layer upper bounds on `Reqs` via constrained generics; this base
 * `defineMethod` is unconstrained.
 *
 * `Effect.provideService(ConnIdTag, ctx.connId)` is a no-op when the
 * body doesn't pull `ConnIdTag` (the `R` channel of `Effect` excludes
 * the tag if absent), so `Reqs` widening doesn't lie about
 * requirements. */
export function defineMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
  Reqs = ConnIdTag,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    handler: (
      params: Static<P>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<R>, E, Reqs>;
    requiresActive?: boolean;
  },
): RpcMethodBinding {
  const requiresActive = def.requiresActive ?? false;
  return handler(definition, (params, ctx) =>
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
      // Architect-stage R-channel cast (Phase 2A r2 plan §3). `Reqs` is a
      // widened generic so handler bodies can `yield* XServiceTag` after
      // the Phase 2A.0 DI migration. At runtime, the dispatcher's
      // `ManagedRuntime` carries `FullLive` (`packages/server/src/app/server.ts`),
      // so the remaining R-channel resolves before this binding's `handle`
      // runs. The Phase 2A.0 implementer threads R through `RpcHandler<Ctx>`
      // and `handler()` from `@moltzap/protocol` structurally and removes
      // this cast.
      const inner = def
        .handler(params, ctx.auth)
        .pipe(Effect.provideService(ConnIdTag, ctx.connId)) as Effect.Effect<
        Static<R>,
        E,
        never
      >;
      const result = yield* inner;
      return result as ResultOf<RpcDefinition<Name, P, R>>;
    }),
  );
}
