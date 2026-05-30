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
 * `MoltZapAgentClient.prototype.subscribe` / `.subscribeAll` once the
 * methods are wired.
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

// Canary #1b — user-defined-type-guard overload exists and resolves at
// call sites. Validated by COMPILATION of a concrete
// `subscribe(def, type-guard)` call. If the type-guard overload is
// deleted from `notification/stream.ts`, this canary fails because the
// call's third-argument signature no longer matches a `params is R`
// shape and TypeScript reports a type error here.
//
// We do not pin the exact post-narrowing payload type via `Equal<>`
// because the conditional in `DecodedNotification<D, R>` interacts with
// overload resolution in a way TypeScript reports as a structural
// mismatch even when the runtime narrowing is correct. The runtime
// narrowing is verified by the property test
// `filter-equivalence.test.ts → "user-defined type guard narrows the
// Stream payload"`; this compile-time canary is the API-shape
// companion (signature exists + matches).
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
// Sanity-check: the stream MUST be assignable to the broad-Stream form.
// This is the weaker invariant (compile-time only) — the runtime
// property test in `filter-equivalence.test.ts` validates the narrowing.
type Canary1b_SubscribeOverloadResolves =
  typeof _canary1bStream extends Stream.Stream<
    DecodedNotification<typeof PresenceChangedNotificationDefinition, any>,
    NotConnectedError,
    never
  >
    ? true
    : false;

// Canary #1b element pin (P3 #627) — the `extends … <def, any>` check
// above uses `any`, which accepts ANY refined `R` and therefore pins
// nothing about the element the overload actually produces. Replace the
// `any` escape hatch with an EXACT `Equal<>` assertion against the
// resolved Stream element type.
//
// The type-guard overload (third arg `params is R`) is selected at this
// call site, but TypeScript resolves the overload's declared return
// `Stream<DecodedNotification<D, R>, …>` by carrying `R` as the
// `unknown`-sentinel default through `DecodedNotification`'s distributive
// conditional (see `rpc-groups.ts → DecodedNotification`), so the
// materialised element is the broad one-arg shape `DecodedNotification<D>`
// — `params.status` stays the full `"online" | "working" | "offline"`
// enum, NOT the value-level-narrowed `"online"` literal. The runtime
// narrowing is verified by the property test in `filter-equivalence.test.ts
// → "user-defined type guard narrows the Stream payload"`; this canary
// pins the COMPILE-TIME element type exactly, off `any`, so any drift in
// either the overload return or `DecodedNotification`'s conditional fails
// here.
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
// P3 #612 fix: ground Canary #3 in the ACTUAL return type of a real
// `Stream.runForEach(_subStreamForCanary, _handlerForCanary)` call,
// not a manually-reconstructed `Effect<…, E, R>` inferred from the
// Stream's own type parameters (which would be a tautology). Calling
// `runForEach` and capturing the return type forces TypeScript to
// resolve the overloads using the real Stream value's signature.
const _ad1Canary3Helper = () =>
  Stream.runForEach(_subStreamForCanary, _handlerForCanary);
type _RunForEachResult = ReturnType<typeof _ad1Canary3Helper>;
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
  assertCanary<Canary1b_SubscribeOverloadResolves>();
  assertCanary<Canary1b_ElementIsExactDecodedNotification>();
  assertCanary<Canary2_SubscribeAllStreamShape>();
  assertCanary<Canary3_RunForEachHasNoLeakedRequirements>();
  assertCanary<Canary4_TypedErrorChannel>();
  // Force the runtime-shape value declarations to be used (otherwise
  // tsc warns even on `declare const`). Also exercises a real call
  // into Stream.runForEach to keep Canary #3's premise grounded.
  Stream.runForEach(_subStreamForCanary, _handlerForCanary);
  _ad1Canary3Helper();
  // Touch `_canary1bStream` so tsc keeps the canary-call expression
  // alive (the `Equal<>` assertion + the assignment below force the
  // overload to resolve at compile time).
  const _touch1b: typeof _canary1bStream = _canary1bStream;
  if (false as boolean) _touch1b;
}
// Discard return so module-level `_ad1Canaries` is read; an assignment
// to `_` satisfies the linter without invoking the function.
const _adhoc_phantom_canary_ref: unknown = _ad1Canaries;
export { _adhoc_phantom_canary_ref };
