/**
 * @file `CapabilityMiddleware` — a per-rpc capability as a first-class
 * middleware (#705 HALF-2, cap-as-middleware reshape).
 *
 * A capability is no longer a runtime descriptor record
 * `{ tag, argsOf: (unknown, unknown) => unknown }` whose params/ctx are
 * erased to `unknown` and re-imposed with `as` casts. It is a
 * metadata-carrying middleware that pairs:
 *   - `provides`: the Spec E `Context.Tag` the handler `yield*`s (effect's
 *     `provides`);
 *   - `derivePayload`: the TYPED, payload-only derivation that reads the
 *     decoded per-method params AND `yield* CurrentPrincipal` (the
 *     principal-as-service read — NO `ctx` parameter); and
 *   - `obtain`: the effect that PRODUCES the provided service value under
 *     `Env` (the today `serverCapabilityProviders` entry, now typed).
 *
 * This mirrors `@effect/rpc`'s `RpcMiddleware.Tag` metadata SHAPE
 * (`provides` / `failure` / `optional` / `wrap`) but stays on the moltzap
 * dispatcher and wire — NO `@effect/rpc` import. moltzap does NOT iterate a
 * runtime set with `as any` (effect's erased `applyMiddleware` form); the
 * dispatcher HAND-EXPANDS a static per-arm `provideServiceEffect` chain,
 * one call per declared middleware with a CONCRETE tag, so each
 * R-subtraction is compiler-checked with no cast.
 *
 * `Params` is the method's DECODED params type, NOT `unknown` — the typed
 * `argsOf` (A9). `derivePayload` returns an `Effect` whose `R` declares
 * `CurrentPrincipal`; the dispatcher provides it around the arm.
 */
import { Effect, type Context } from "effect";
import type { CurrentPrincipal } from "./current-principal.js";

/**
 * The variance-agnostic `provides`-tag surface. `Context.Tag` is invariant
 * in both parameters, so a concrete class tag
 * (`Context.Tag&lt;TaskReadAccess, TaskReadAccessValue&gt;`) is NOT assignable to
 * `Context.Tag&lt;unknown, unknown&gt;`. `Context.Tag&lt;any, any&gt;` is the constraint
 * the repo's existing `CapabilityDescriptor.tag` uses for the same reason
 * (`capabilities.ts → AnyContextTag`); `Context.Tag.Identifier&lt;Provides&gt;` /
 * `Context.Tag.Service&lt;Provides&gt;` recover the per-tag types downstream.
 */
type AnyContextTag = Context.Tag<any, any>;

/**
 * A per-rpc capability middleware. The carrier for the middleware-reshaped
 * descriptor caps.
 * @template Params - the method's decoded params type (A9 typed-argsOf).
 * @template Provides - the `Context.Tag` the middleware PROVIDES; the
 * handler's R declares `Context.Tag.Identifier` of it.
 * @template Input - the obtain helper's input (the `derivePayload` output
 * ↔ `obtain` input shared type).
 * @template Env - the env the `obtain` runs under (the slot's `Env`).
 * @template Fail - optional obtain failure (`Forbidden`/`NotFound`),
 * mapped to a `-32xxx` wire error by the dispatcher's existing
 * `wireErrorFromInstance` projection (we KEEP the wire-error model — no
 * `Schema.Exit` encoding).
 */
export interface CapabilityMiddleware<
  Params,
  Provides extends AnyContextTag,
  Input,
  Env,
  Fail = never,
> {
  /** The service Tag the middleware PROVIDES (effect's `provides`). */
  readonly provides: Provides;

  /**
   * Typed, payload-only payload-derivation (was `CapabilityDescriptor.argsOf`).
   * Reads the DECODED per-method params (A9: `Params`, not `unknown`) and
   * the principal via `yield* CurrentPrincipal` (NO `ctx` parameter). The
   * `R` channel declares `CurrentPrincipal`; the dispatcher provides it.
   */
  readonly derivePayload: (
    params: Params,
  ) => Effect.Effect<Input, never, CurrentPrincipal>;

  /**
   * Obtain the service value under `Env` (the today
   * `serverCapabilityProviders` entry, now typed: input is `derivePayload`'s
   * output, output is the `Provides` service value).
   */
  readonly obtain: (
    input: Input,
  ) => Effect.Effect<Context.Tag.Service<Provides>, Fail, Env>;
}

/**
 * The tuple of middlewares carried on a definition's `middlewares` field.
 * Each element's `Params` is the OWNING method's decoded params type. The
 * `unknown`/`never` slots are intentionally wide here — the per-method
 * tuple narrows them at the descriptor literal (the same erasure-vs-recover
 * pattern as `CapabilityDescriptor` / `CapabilitiesOf`).
 */
// `Input`/`Env`/`Fail` are `any` (NOT `unknown`): `Input` is contravariant
// in `obtain`'s parameter, so `unknown` there would reject a middleware with
// a concrete input. `AnyCapabilityMiddleware` is the storage/erased shape
// (used only to PIN `MiddlewaresOf`'s `provides` tag union — the obtain
// types are recovered per-middleware at the concrete declaration).
export type AnyCapabilityMiddleware = CapabilityMiddleware<
  never,
  AnyContextTag,
  any,
  any,
  any
>;

/**
 * Type-level extractor: the union of cap-tag IDENTIFIERS the `middlewares`
 * tuple on a definition `D` PROVIDES — i.e. the `Context.Tag.Identifier`
 * (= `Self` instance type, for the repo's class tags) of each `provides`
 * tag, which is the type a handler's R-channel actually holds AND the type
 * `provideServiceEffect(tag, …)` subtracts. (Projecting to the raw `provides`
 * tag VALUE type `typeof Tag` would be WRONG — that is not what R holds, so
 * the totality bound would never subtract.) Mirrors `CapIdentsOf` for the
 * middleware surface. When `D["middlewares"]` is absent, resolves to
 * `never` (the method contributes no capability requirements).
 */
export type MiddlewaresOf<D> = D extends {
  readonly middlewares: ReadonlyArray<infer M>;
}
  ? M extends { readonly provides: infer Tag }
    ? Tag extends AnyContextTag
      ? Context.Tag.Identifier<Tag>
      : never
    : never
  : never;

/**
 * Apply ONE {@link CapabilityMiddleware} as a `provideServiceEffect` step:
 * `derivePayload(params)` (reads `CurrentPrincipal` via `yield*`) →
 * `flatMap(obtain)` → `provideServiceEffect(mw.provides, …)`. Returns a
 * `pipe`-able function so a binding site composes its method's chain by
 * listing one `provideMiddleware(mw, params)` per declared cap in REVERSE
 * declaration order (FIRST-declared = OUTERMOST, for
 * Forbidden-before-state-probe).
 *
 * This is a PER-MIDDLEWARE step, NOT a variadic tuple-fold (cap-reshape
 * Concern 5 — a tuple-fold is unproven cast-free). `mw.provides` is a
 * CONCRETE tag at each call, so TS subtracts exactly that tag's `Identifier`
 * from the accumulator R — the spike-proven EXIT-0 R-subtraction, no cast.
 * The `CurrentPrincipal` requirement of `derivePayload` rides out on the
 * step's R; the dispatcher's `provideService(CurrentPrincipal, …)` (around
 * the whole arm) discharges it.
 */
export const provideMiddleware =
  <Params, Provides extends AnyContextTag, Input, Env, Fail>(
    mw: CapabilityMiddleware<Params, Provides, Input, Env, Fail>,
    params: Params,
  ) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | Fail,
    Exclude<R, Context.Tag.Identifier<Provides>> | Env | CurrentPrincipal
  > =>
    Effect.provideServiceEffect(
      effect,
      mw.provides,
      mw.derivePayload(params).pipe(Effect.flatMap(mw.obtain)),
    );
