/**
 * Type-canary for the `subscribe` / `subscribeAll` public signatures.
 *
 * Compile-time assertions only — `tsc --build` picks this file up via the
 * package's vitest config glob, but it has no runtime test bodies. Any
 * drift in the `subscribe` / `subscribeAll` signatures, or in the Stream
 * lifecycle contract they expose, surfaces as a TypeScript error here.
 *
 * The runtime companions live in `filter-equivalence.test.ts` (the
 * type-guard overload's payload narrowing) and `snapshot-semantics.test.ts`
 * (Stream-cancellation snapshot semantics).
 */
import { Stream } from "effect";
import type { Effect } from "effect";
import type {
  AnyNotificationDefinition,
  DecodedNotification,
  NotConnectedError,
  NotificationParamsOf,
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

// Canary #1 — `subscribe(def)` returns a value-typed Stream with R=never.
// The single-argument overload yields the broad element type
// `DecodedNotification<D>`; the type-guard overload (Canary #1b) narrows it.
type Canary1_SubscribeStreamShape<D extends AnyNotificationDefinition> = Equal<
  ReturnType<typeof subscribe<D>>,
  Stream.Stream<DecodedNotification<D>, NotConnectedError, never>
>;

// Canary #1b — the user-defined-type-guard overload exists and resolves at
// call sites. Validated by COMPILATION of a concrete `subscribe(def,
// type-guard)` call: if the type-guard overload is deleted from `stream.ts`,
// the third-argument `params is R` shape no longer matches and tsc reports
// a type error here.
import type { SubscriberRegistry } from "../../runtime/subscribers.js";
import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
declare const _canary1bRegistry: SubscriberRegistry;
type _Canary1bPresenceParams = NotificationParamsOf<
  typeof PresenceChangedNotificationDefinition
>;
type _Canary1bOnlinePresence = _Canary1bPresenceParams & { status: "online" };
declare const _canary1bIsOnline: (
  params: _Canary1bPresenceParams,
) => params is _Canary1bOnlinePresence;
const _canary1bStream = subscribe(
  _canary1bRegistry,
  PresenceChangedNotificationDefinition,
  _canary1bIsOnline,
);
// The stream MUST stay assignable to the broad-Stream form. This is the
// compile-time invariant only; the runtime narrowing is the job of the
// property test in `filter-equivalence.test.ts`.
type Canary1b_SubscribeOverloadResolves =
  typeof _canary1bStream extends Stream.Stream<
    DecodedNotification<typeof PresenceChangedNotificationDefinition, any>,
    NotConnectedError,
    never
  >
    ? true
    : false;

// Canary #1b element pin — Canary #1b above uses `any`, which accepts any
// refined `R` and so pins nothing about the materialised element. This
// canary holds an EXACT `Equal<>` against the resolved Stream element so the
// `any` escape hatch cannot mask element drift. tsc carries the type-guard's
// `R` as the unknown-sentinel default through `DecodedNotification`'s
// distributive conditional, so the element resolves to the broad one-arg
// shape `DecodedNotification<D>` — `params.status` stays the full
// `"online" | "working" | "offline"` enum, NOT the value-level-narrowed
// `"online"` literal. The runtime narrowing is verified by the property test
// in `filter-equivalence.test.ts`.
type _Canary1bElement = Stream.Stream.Success<typeof _canary1bStream>;
type Canary1b_ElementIsExactDecodedNotification = Equal<
  _Canary1bElement,
  DecodedNotification<typeof PresenceChangedNotificationDefinition>
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

// Canary #3 — running `subscribe(def)` via `Stream.runForEach` produces an
// Effect whose Context is exactly `never`: the Stream's internal Scope (set
// up by `Stream.unwrapScoped` around `acquireRelease`) is consumed inside the
// Stream value, never exposed to the consumer's `runForEach`. Cancellation
// propagates via fiber interrupt → internal scope finalizer → unregister.
//
// The canary grounds the assertion in the ACTUAL return type of a real
// `Stream.runForEach(...)` call, not an `Effect<…, E, R>` reconstructed from
// the Stream's own type parameters (which would be a tautology). Calling
// `runForEach` forces tsc to resolve the overloads against the real value.
declare const _subStreamForCanary: ReturnType<
  typeof subscribe<AnyNotificationDefinition>
>;
declare const _handlerForCanary: (
  n: DecodedNotification<AnyNotificationDefinition>,
) => Effect.Effect<void, never, never>;
const _ad1Canary3Helper = () =>
  Stream.runForEach(_subStreamForCanary, _handlerForCanary);
type _RunForEachResult = ReturnType<typeof _ad1Canary3Helper>;
type Canary3_RunForEachHasNoLeakedRequirements = Equal<
  Effect.Effect.Context<_RunForEachResult>,
  never
>;

// Canary #4 — the typed-error channel on subscribe is exactly
// `NotConnectedError`, not `unknown` or a wider union. A closed client is
// the only terminal error the Stream surfaces.
type Canary4_TypedErrorChannel = Equal<
  Stream.Stream.Error<ReturnType<typeof subscribe<AnyNotificationDefinition>>>,
  NotConnectedError
>;

// Phantom value-level call sites: pin each Canary alias as used and let
// knip/oxlint see the file as fully reachable. tsc never invokes
// `_ad1Canaries`; the canary alias resolutions happen at type-check time
// inside the function body.
function _ad1Canaries<D extends AnyNotificationDefinition>(): void {
  assertCanary<Canary1_SubscribeStreamShape<D>>();
  assertCanary<Canary1b_SubscribeOverloadResolves>();
  assertCanary<Canary1b_ElementIsExactDecodedNotification>();
  assertCanary<Canary2_SubscribeAllStreamShape>();
  assertCanary<Canary3_RunForEachHasNoLeakedRequirements>();
  assertCanary<Canary4_TypedErrorChannel>();
  // Force the runtime-shape value declarations to be used (otherwise tsc
  // warns even on `declare const`). Also exercises a real call into
  // `Stream.runForEach` to keep Canary #3's premise grounded.
  Stream.runForEach(_subStreamForCanary, _handlerForCanary);
  _ad1Canary3Helper();
  // Touch `_canary1bStream` so tsc keeps the canary-call expression alive
  // (the `Equal<>` assertion + the assignment below force the overload to
  // resolve at compile time).
  const _touch1b: typeof _canary1bStream = _canary1bStream;
  if (false as boolean) _touch1b;
}
// Discard return so module-level `_ad1Canaries` is read; an assignment to
// `_` satisfies the linter without invoking the function.
const _adhoc_phantom_canary_ref: unknown = _ad1Canaries;
export { _adhoc_phantom_canary_ref };
