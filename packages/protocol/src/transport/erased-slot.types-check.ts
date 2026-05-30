/**
 * @file Type canaries for the #705 HALF-1 cast-free `makeErasedSlot`.
 *
 * Reproduces the retired Canary 7 (handler R ⊆ declared capabilities) on
 * the LIVE slot-factory the production server actually builds, plus the
 * value-half lockstep the never-instantiated `ServerHandlers` table never
 * proved. Negative cases use `@ts-expect-error` — `tsc --noEmit` fails
 * with TS2578 ("Unused '@ts-expect-error' directive") if a marked line
 * ever stops erroring.
 *
 * Two false-green traps the set is authored to AVOID (both spike-verified):
 *   1. The Tag VALUE channel (`typeof Tag`) is NOT what a real handler's R
 *      holds — a handler's R holds the Tag IDENTIFIER (= `Self`, the
 *      instance type, for the repo's class-style tags). The R⊆Caps
 *      negative tests the `Self` channel via `CapIdentsOf&lt;CapsTuple>`.
 *   2. A FREE `Env` makes the R⊆Caps negative false-green (TS widens `Env`
 *      to swallow the undeclared cap). The canaries call through
 *      `slotWithPinnedEnv` — a `makeErasedSlot` alias that FIXES
 *      `Env = DbTag` so inference cannot widen it from the handler arg.
 *
 * Format-stability note: each slot-factory call is authored over
 * PRE-DECLARED `handler` / `providers` consts so the call is a single
 * line oxfmt cannot reflow — keeping each `@ts-expect-error` attached to
 * the call line rather than drifting onto an inner property after format.
 */

import { Context, Effect, type Exit } from "effect";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

import { defineRpc, type RpcDefinition } from "./method.js";
import type { CapabilityDescriptor } from "./capabilities.js";
import {
  makeErasedSlot,
  type CapIdentsOf,
  type CapProviders,
  type ErasedSlot,
  type SlotDispatchContext,
} from "./erased-slot.js";

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * A concrete service-tag union to PIN `Env` to (a stand-in for the
 *  wrapper's `NetworkTags`/`TaskTags`/`AppTags` layer union).
 */
class DbTag extends Context.Tag("@moltzap/test/DbTag")<DbTag, "db">() {}
type Env = DbTag;

/**
 * Two class-style capability tags (the repo's actual tag shape — for a
 *  class tag, `Context.Tag.Identifier&lt;Tag>` is the `Self` instance type,
 *  NOT the string key).
 */
class CapA extends Context.Tag("@moltzap/test/CapA")<CapA, "capA">() {}
class CapB extends Context.Tag("@moltzap/test/CapB")<CapB, "capB">() {}

/**
 * A THIRD, UNDECLARED cap — leaking it into a handler's R is the R⊆Caps
 *  / Env-leak violation the negatives catch.
 */
class CapC extends Context.Tag("@moltzap/test/CapC")<CapC, "capC">() {}

/**
 * A minimal `defineRpc` carrying a two-cap tuple. The `as const` on the
 *  `capabilities` array preserves the literal tuple shape so `CapsTuple`
 *  is the 2-element tuple, never `never`.
 */
const TwoCapMethod = defineRpc({
  name: "test/two-cap",
  params: Type.Object({ x: Type.Number() }, { additionalProperties: false }),
  result: Type.Object({ y: Type.Number() }, { additionalProperties: false }),
  capabilities: [
    { tag: CapA, argsOf: () => undefined },
    { tag: CapB, argsOf: () => undefined },
  ] as const satisfies ReadonlyArray<CapabilityDescriptor>,
});

type TwoCapTuple = typeof TwoCapMethod.capabilities;
type Params = Static<typeof TwoCapMethod.paramsSchema>;
type Result = Static<typeof TwoCapMethod.resultSchema>;

/**
 * Stand-in for the server's 3-arm `Connection` (the slot factory is
 *  generic over `Conn`).
 */
interface Conn {
  readonly _tag: "Stub";
}
type Ctx = SlotDispatchContext<Conn>;

/**
 * `makeErasedSlot` with `Env` and `Conn` PINNED — inference cannot widen
 * `Env` to absorb an undeclared cap from the handler arg (the false-green
 * trap). The real wrappers in `define-layered-method.ts` pin `Env` to
 * their layer service-tag union the same way; the canary fixes it to
 * `DbTag`. Only `Name`/`P`/`R`/`E`/`CapsTuple` stay inferred.
 */
function slotWithPinnedEnv<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
>(
  definition: Omit<RpcDefinition<Name, P, R>, "capabilities"> & {
    readonly capabilities: CapsTuple;
  },
  // `CapsTuple` inferred ONLY from `definition`/`providers`; `NoInfer`
  // blocks the handler from widening it to admit an undeclared cap.
  handler: (
    params: Static<P>,
    ctx: SlotDispatchContext<Conn>,
  ) => Effect.Effect<Static<R>, E, NoInfer<Env | CapIdentsOf<CapsTuple>>>,
  providers: CapProviders<CapsTuple, Env>,
): ErasedSlot<Env, Conn> {
  return makeErasedSlot(definition, handler, providers);
}

const provA = (_args: unknown): Effect.Effect<"capA", unknown, Env> =>
  Effect.succeed("capA");
const provB = (_args: unknown): Effect.Effect<"capB", unknown, Env> =>
  Effect.succeed("capB");
const provWrong = (_args: unknown): Effect.Effect<"capB", unknown, Env> =>
  Effect.succeed("capB");

const properProviders: CapProviders<TwoCapTuple, Env> = [provA, provB];

// ───────────────────────────────────────────────────────────────────
// Positive control: handler yields ONLY declared caps (its R holds the
// `Self` identifiers via `CapIdentsOf`), with a matching positional
// `providers` tuple, `Env` pinned. Compiles. The returned slot's
// `invoke` R is `Env` (capabilities discharged inside) — asserted below.
// ───────────────────────────────────────────────────────────────────

const okHandler = (
  _params: Params,
  _ctx: Ctx,
): Effect.Effect<Result, never, Env | CapIdentsOf<TwoCapTuple>> =>
  Effect.gen(function* () {
    yield* CapA;
    yield* CapB;
    yield* DbTag;
    return { y: 1 };
  });
const _okSlot = slotWithPinnedEnv(TwoCapMethod, okHandler, properProviders);

// The slot boundary is honestly typed: `invoke` R is `Env` (NOT `never`,
// NOT the cap union) — capabilities are discharged inside.
declare const _okCtx: Ctx;
const _okInvokeR: Effect.Effect<
  Exit.Exit<unknown, unknown>,
  never,
  Env
> = _okSlot.invoke(undefined, _okCtx);

// ───────────────────────────────────────────────────────────────────
// Negative 7a (R⊆Caps): handler yields an UNDECLARED cap (`CapC`'s
// `Self`) → R widens past `Env | CapIdentsOf<TwoCapTuple>`, REJECTED.
// `Env` is pinned by `slotWithPinnedEnv` so it cannot widen to swallow
// `CapC`.
// ───────────────────────────────────────────────────────────────────

const leakyHandler = (
  _params: Params,
  _ctx: Ctx,
): Effect.Effect<Result, never, Env | CapC> =>
  Effect.gen(function* () {
    yield* CapC;
    return { y: 1 };
  });
const _leakSlot7a = slotWithPinnedEnv(
  TwoCapMethod,
  // @ts-expect-error — handler R leaks CapC (not in CapIdentsOf<TwoCapTuple>); R⊆Caps half, Env pinned.
  leakyHandler,
  properProviders,
);

// ───────────────────────────────────────────────────────────────────
// Negative 7b (provider arity): `providers` MISSING an element →
// tuple-arity mismatch, REJECTED. (The mapped-type-keyed-by-Identifier
// equivalent would NOT fire on class-tags — the positional tuple does.)
// ───────────────────────────────────────────────────────────────────

const oneProvider: readonly [typeof provA] = [provA];
const _aritySlot7b = slotWithPinnedEnv(
  TwoCapMethod,
  okHandler,
  // @ts-expect-error — providers tuple is 1 element; descriptor declares 2 caps (arity mismatch).
  oneProvider,
);

// ───────────────────────────────────────────────────────────────────
// Negative 7c (wrong service): a `providers` element yields the WRONG
// service value in slot 0 → element-type mismatch, REJECTED.
// ───────────────────────────────────────────────────────────────────

const wrongProviders: readonly [typeof provWrong, typeof provB] = [
  provWrong,
  provB,
];
const _wrongSlot7c = slotWithPinnedEnv(
  TwoCapMethod,
  okHandler,
  // @ts-expect-error — providers[0] yields "capB" but CapA's service is "capA" (element-type mismatch).
  wrongProviders,
);

// ───────────────────────────────────────────────────────────────────
// Negative 7d (Env-leak guard): an effect that `yield*`s an undeclared
// cap CANNOT be assigned to the PINNED `Env` bound — its R widens past
// `Env`. 7d and 7a are the two halves of the same pinned-`Env`
// obligation: 7a proves the slot factory rejects it; 7d proves the bare
// R-channel assignability that the factory relies on.
// ───────────────────────────────────────────────────────────────────

const envLeakEffect = Effect.gen(function* () {
  yield* CapC;
  return { y: 1 };
});
// @ts-expect-error — effect R leaks CapC; not assignable to the pinned Env bound (Env-leak).
const _envLeak7d: Effect.Effect<Result, never, Env> = envLeakEffect;

// Export each canary local as a discriminated union so the unused-vars
// rule cannot trim them in a future refactor.
export type _ErasedSlotCanarySink =
  | typeof _okSlot
  | typeof _okInvokeR
  | typeof _leakSlot7a
  | typeof _aritySlot7b
  | typeof _wrongSlot7c
  | typeof _envLeak7d;
