/**
 * @file Cast-free middleware slot — #705 HALF-2 slice-1.
 *
 * The cast-free successor to `makeErasedSlot` for methods whose
 * capabilities have been reshaped into {@link CapabilityMiddleware}. It
 * produces the SAME existential {@link ErasedSlot} shape `makeErasedSlot`
 * does — `invoke: (params, ctx) => Effect&lt;Exit, never, Env&gt;` — so a
 * middleware-slot stores in the SAME {@link ErasedSlotTable} as a legacy
 * erased slot WITHOUT a widening cast (the registry is heterogeneous in
 * mechanism but homogeneous in slot type, because both bottom out at
 * residual `R = Env`).
 *
 * The DIFFERENCE from `makeErasedSlot`: the capability discharge is NOT a
 * runtime `reduce` over `definition.capabilities` (the `dischargeCaps`
 * carve-out, whose R-subtraction needed a type-erasure cast). It is a STATIC,
 * hand-expanded `provideServiceEffect` chain woven at the binding site
 * (where each method's middleware tuple is a compile-time literal), passed
 * in here as a pre-composed `runGatedBody`. Each `provideServiceEffect`
 * names a CONCRETE tag, so TS subtracts exactly that tag's `Identifier`
 * from R; after the chain (plus the dispatcher's
 * `provideService(CurrentPrincipal, …)`) the residual R is `Env`,
 * compiler-checked with NO assertion.
 *
 * So this slot has NO `dischargeCaps`, NO `narrowToDispatchContext`, NO
 * `argsOf(unknown, unknown): unknown` erasure boundary — all of which the
 * legacy `erased-slot.ts` carries. The slice's grep-zero target.
 *
 * `invoke` decodes `params` via the method's OWN validator (a genuine
 * `d is Schema.Schema.Type&lt;P&gt;` narrow via the Effect-`Schema`-backed
 * `validateParams` guard, the same honest wire-dynamic boundary), then
 * runs the pre-composed gated body. A params-decode failure surfaces as a
 * success-typed `Exit.Failure` the dispatcher projects to `InvalidParams`.
 */
import { Effect, Exit, Schema } from "effect";

import { decodeRpcParams, type RpcDefinition } from "./method.js";
import type { ErasedSlot, SlotDispatchContext } from "./erased-slot.js";

/**
 * The fully-composed gated body the binding site hands `makeMiddlewareSlot`.
 *
 * It is the #720-gated handler with its STATIC per-arm capability
 * `provideServiceEffect` chain ALREADY woven AND the dispatcher's
 * `provideService(CurrentPrincipal, …)` + `provideService(ConnectionTag,
 * …)` ALREADY applied — so its residual `R` is exactly `Env` (cap tags and
 * `CurrentPrincipal` and `ConnectionTag` all subtracted, compiler-checked).
 * `makeMiddlewareSlot` only adds the param decode + the `Exit` projection.
 *
 * `E` is `never` because the gated body has already `Effect.exit`'d its
 * outcome into the success channel (mirrors `makeErasedSlot.invoke`, which
 * returns `Effect&lt;Exit&lt;…&gt;, never, Env&gt;`).
 */
export type GatedMiddlewareBody<
  P extends Schema.Schema.AnyNoContext,
  Conn,
  Env,
> = (
  params: Schema.Schema.Type<P>,
  ctx: SlotDispatchContext<Conn>,
) => Effect.Effect<Exit.Exit<unknown, unknown>, never, Env>;

/**
 * Build a real {@link ErasedSlot} from a definition + a fully-composed,
 * cast-free {@link GatedMiddlewareBody}. The body's caps were discharged by
 * a STATIC per-arm `provideServiceEffect` chain at the binding site, so
 * there is no runtime-fold carve-out to subtract R — the residual `R = Env`
 * is the body's own honest type. `invoke` adds the param decode; on decode
 * success it runs the body (which already returns the inner `Exit`).
 */
export function makeMiddlewareSlot<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  Conn,
  Env,
>(
  definition: RpcDefinition<Name, P, R>,
  body: GatedMiddlewareBody<P, Conn, Env>,
): ErasedSlot<Env, Conn> {
  const invoke = (
    params: unknown,
    ctx: SlotDispatchContext<Conn>,
  ): Effect.Effect<Exit.Exit<unknown, unknown>, never, Env> =>
    Effect.gen(function* () {
      const decoded = yield* Effect.exit(decodeRpcParams(definition, params));
      if (Exit.isFailure(decoded)) {
        return decoded;
      }
      return yield* body(decoded.value, ctx);
    }).pipe(Effect.withSpan("MiddlewareSlot.invoke"));
  return { definition, invoke };
}
