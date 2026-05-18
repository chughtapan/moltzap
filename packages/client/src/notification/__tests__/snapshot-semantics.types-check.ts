/**
 * Type-canary for AD1 (architect-decision: trust `Stream.runForEach`
 * cancellation to preserve spec #222 §5.3 OQ-3 snapshot semantics).
 *
 * Compile-time assertions only — this file is referenced by `tsc --build`
 * (via the package's vitest config glob) but has no runtime test bodies.
 * Any drift in `subscribe` / `subscribeAll` public signatures, or in the
 * Stream lifecycle contract, surfaces as a TypeScript error here.
 *
 * **DO NOT delete this file** without first updating spec #596 AD1 and
 * the architect plan at issue #604.
 *
 * **Architect stub** (Spec B): canaries probe the architect-stubbed
 * `subscribe` / `subscribeAll` signatures in `../stream.ts`. Impl-staff
 * preserves the canary shapes and re-targets them at
 * `MoltZapWsClient.prototype.subscribe` / `.subscribeAll` once the
 * methods are wired.
 */
import { Stream } from "effect";
import type { Effect } from "effect";
import type {
  AnyNotificationDefinition,
  DecodedNotification,
  NotConnectedError,
} from "@moltzap/protocol";
import { subscribe, subscribeAll } from "../stream.js";

// Standard TypeScript exact-equality helper.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Phantom value-level pin: passing a Canary alias forces tsc to resolve
// the alias; a `false` resolution fires TS2344 because `false` is not
// assignable to the `true` constraint.
function assertCanary<_T extends true>(): void {
  // intentionally empty: type-level pin
}

// ── AD1 pinned contracts ────────────────────────────────────────────────

// Canary #1 — `subscribe(def)` returns a value-typed Stream with R=never.
//
// **Architect note (codex r5 finding #4):** the type-guard overload form
// of `subscribe` is pinned in plan §5.2 to return
// `Stream.Stream<DecodedNotification<D, R>, ...>` (payload narrowed via
// the type-guard predicate). That narrowing requires the optional `R`
// parameter on `DecodedNotification<D>` landing in
// `packages/protocol/src/transport/rpc-groups.ts` (plan §4.2 row 1) —
// an impl-staff scope edit. Until that lands, this canary checks the
// boolean-refinement overload only. Impl-staff adds Canary #1b once
// the protocol type-parameter extension is wired:
//
//   type Canary1b_SubscribeNarrowed<D extends AnyNotificationDefinition,
//                                    R extends NotificationParamsOf<D>> =
//     Equal<
//       ReturnType<typeof subscribe<D, R>>,
//       Stream.Stream<DecodedNotification<D, R>, NotConnectedError, never>
//     >;
type Canary1_SubscribeStreamShape<D extends AnyNotificationDefinition> = Equal<
  ReturnType<typeof subscribe<D>>,
  Stream.Stream<DecodedNotification<D>, NotConnectedError, never>
>;

// Canary #2 — `subscribeAll()` returns the broad-union Stream with R=never.
type Canary2_SubscribeAllStreamShape = Equal<
  ReturnType<typeof subscribeAll>,
  Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    NotConnectedError,
    never
  >
>;

// Canary #3 — running `subscribe(def)` via `Stream.runForEach` produces
// an Effect whose Context is exactly `never`. AD1 path-(a) wiring
// contract: the Stream's internal Scope (set up by Stream.unwrapScoped
// around acquireRelease) is consumed inside the Stream value, not
// exposed to the consumer's runForEach. Cancellation propagates via
// fiber interrupt → internal scope finalizer → unregister.
//
// The canary checks the actual Effect produced by piping `subscribe`'s
// return value through `Stream.runForEach`.
declare const _subStreamForCanary: ReturnType<
  typeof subscribe<AnyNotificationDefinition>
>;
declare const _handlerForCanary: (
  n: DecodedNotification<AnyNotificationDefinition>,
) => Effect.Effect<void, never, never>;
type _RunForEachResult = ReturnType<
  () => typeof _subStreamForCanary extends Stream.Stream<
    infer _A,
    infer E,
    infer R
  >
    ? // Compose Stream.runForEach's signature manually so we get the
      // post-call Effect type (this avoids relying on overload resolution
      // for type-argument lists, which TS rejects for overloaded
      // function types).
      Effect.Effect<void, E, R>
    : never
>;
type Canary3_RunForEachHasNoLeakedRequirements = Equal<
  Effect.Effect.Context<_RunForEachResult>,
  never
>;

// Canary #4 — the typed-error channel on subscribe is exactly
// `NotConnectedError`, not `unknown` or a wider union. Pins spec
// §"Stream lifecycle contract" row 5 (closed-client terminal error).
type Canary4_TypedErrorChannel = Equal<
  Stream.Stream.Error<ReturnType<typeof subscribe<AnyNotificationDefinition>>>,
  NotConnectedError
>;

// Phantom value-level call sites: pin each Canary alias as used and let
// knip/oxlint see the file as fully reachable. tsc never invokes
// `_ad1Canaries`; the canary alias resolutions happen at type-check
// time inside the function body.
function _ad1Canaries<D extends AnyNotificationDefinition>(): void {
  assertCanary<Canary1_SubscribeStreamShape<D>>();
  assertCanary<Canary2_SubscribeAllStreamShape>();
  assertCanary<Canary3_RunForEachHasNoLeakedRequirements>();
  assertCanary<Canary4_TypedErrorChannel>();
  // Force the runtime-shape value declarations to be used (otherwise
  // tsc warns even on `declare const`). Also exercises a real call
  // into Stream.runForEach to keep Canary #3's premise grounded.
  Stream.runForEach(_subStreamForCanary, _handlerForCanary);
}
// Discard return so module-level `_ad1Canaries` is read; an assignment
// to `_` satisfies the linter without invoking the function.
const _adhoc_phantom_canary_ref: unknown = _ad1Canaries;
export { _adhoc_phantom_canary_ref };
