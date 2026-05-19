import { Context, Effect } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  ForbiddenError,
  type HandlerSlot,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import { ConnIdTag } from "../app/layers.js";
import type { AgentId, UserId } from "../app/types.js";

export interface AuthenticatedContext {
  agentId: AgentId;
  agentStatus: string;
  ownerUserId: UserId | null;
}

/** Per-request dispatch context handed to every RPC handler by the typed dispatcher. */
export interface DispatchContext {
  readonly auth: AuthenticatedContext;
  readonly connId: string;
}

/**
 * RPC binding stored in the registry. Each binding carries a method
 * definition and a Spec F (#617) typed-dispatcher `HandlerSlot`-shaped
 * handler that already provides `ConnIdTag` from the dispatch context.
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
    ) => Effect.Effect<Static<R>, E, Reqs | ConnIdTag>;
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
      // `Effect<Static<R>, E, Reqs | ConnIdTag>`.
      // `Effect.provideService(ConnIdTag, ctx.connId)` removes ConnIdTag;
      // remaining Reqs ride through into the `HandlerSlot.handle` R
      // channel and are resolved by the dispatcher's `ManagedRuntime` at
      // request time.
      const result = yield* def
        .handler(params, ctx.auth)
        .pipe(Effect.provideService(ConnIdTag, ctx.connId));
      return result as ResultOf<RpcDefinition<Name, P, R>>;
    }).pipe(Effect.withSpan("defineMethod"));
  return {
    definition,
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- HandlerSlot.handle's params type narrows to `ParamsOf<D>` (= `Static<P>` post-decode); the dispatcher passes the AJV-narrowed value, so the erasure-via-binding is safe (Spec F §3 carve-out).
    handle: slotHandle as unknown as RpcMethodBinding["handle"], // #ignore-sloppy-code[as-unknown-as]: HandlerSlot.handle's params type narrows to `ParamsOf<D>` post-decode; the dispatcher's AJV-narrowed value satisfies the constraint at runtime (Spec F §3 carve-out)
  };
}
