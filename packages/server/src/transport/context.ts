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
import type { AppTags } from "./layer-tags.js";

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
 * provides the layer scopes + ConnIdTag service.
 *
 * `R` is the union of handler-body Tag requirements AFTER the
 * `defineMethod` wrapper resolves `ConnIdTag` (provided per request
 * from `DispatchContext.connId`). The remaining tags are the service
 * Tags that the dispatcher's `FullLive` Layer provides at request
 * time. We use `Exclude<AppTags, ConnIdTag>` so the dispatcher's
 * `Effect.provide(FullLive)` resolves R structurally to `never`. */
export type RpcMethodBinding = RpcHandler<
  DispatchContext,
  Exclude<AppTags, ConnIdTag>
>;

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
  Reqs extends AppTags = ConnIdTag,
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
  // Explicit type args so TS infers R from the inner Effect's R-channel
  // rather than defaulting to `never`. `handler<D, Ctx, R>` from
  // `@moltzap/protocol` carries R through to the binding.
  return handler<
    RpcDefinition<Name, P, R>,
    DispatchContext,
    Exclude<Reqs, ConnIdTag>
  >(definition, (params, ctx) =>
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
      // R-channel: `def.handler` returns `Effect<Static<R>, E, Reqs>`.
      // `Effect.provideService(ConnIdTag, ctx.connId)` removes ConnIdTag
      // if present. The remaining R rides through `handler()` (widened
      // in `@moltzap/protocol` to `RpcHandler<Ctx, R>`) and is resolved
      // by the dispatcher's `ManagedRuntime` at request time. No cast.
      const result = yield* def
        .handler(params, ctx.auth)
        .pipe(Effect.provideService(ConnIdTag, ctx.connId));
      return result as ResultOf<RpcDefinition<Name, P, R>>;
    }),
  );
}
