/**
 * @file Type-canary for Spec A (#595) AC1 — final public-barrel shape.
 *
 * This file does NOT run at runtime; it's a compile-time canary that
 * `tsc --noEmit` evaluates. The expectations fail to compile if the
 * barrel drifts from what Spec A AC1 promises.
 *
 * Architect-tier (#603) ships this canary with TWO assertions:
 *   (1) the V2-aliased names exist in the stub branch (so the stub
 *       compiles against the legacy + new co-exporting barrel);
 *   (2) the unaliased names also exist (so impl-staff's cutover —
 *       which deletes the legacy exports and renames the V2 aliases
 *       — is verified by the same canary file without further edits).
 *
 * Post-cutover state (impl-staff): assertion (1) becomes vacuous (the
 * V2 aliases delete). The file remains; if a future refactor
 * accidentally re-introduces a `V2` alias, the canary fails — drawing
 * attention back to AC1's "final barrel exports the unaliased names"
 * bar.
 *
 * Codex R3 finding #5: "the stub branch does not match the promised
 * public surface" — this canary makes the deviation an explicit
 * staged exception, with a compile-time gate on its removal.
 */
import type {
  // Surface names that are Connection-native in the stub branch and
  // do NOT collide with legacy `json-rpc-{server,client}.ts` exports.
  Connection,
  ConnectionConfig,
  ConnectionContext,
  DecodedRequest,
  HookFailure,
  JsonValue,
  Subscription,
  ServerConnection,
  ClientConnection,
  ConnectionRunError,
  RemoteTaggedError,
  // F3 named-union aliases on the Connection public surface (r1 — r2
  // propagated to stub). Each line below fails compile if the alias
  // disappears from the barrel.
  ConnectionCallError,
  ConnectionWriteError,
  ConnectionRegisterError,
} from "./index.js";

// Connection-native names that COLLIDE with legacy exports in the
// stub branch. The barrel re-exports the Connection-native forms
// under the `V2` suffix until impl-staff's cutover deletes the
// legacy exports. After cutover (per AC1's stub-only-deviation note
// in plan #603), impl-staff renames `RpcHandlerV2 → RpcHandler` and
// `RpcCallErrorV2 → RpcCallError` in the barrel + on this import
// line. Codex r1 F7 fix: the canary now references the V2 names
// explicitly so it gates the CONNECTION-NATIVE shape, not the legacy
// shape that the unaliased names currently resolve to.
import type { RpcHandlerV2, RpcCallErrorV2 } from "./index.js";
// `Connect` — the auth-establishing bootstrap RPC. The F6 gate below
// asserts that `register(Connect, …)` requires `RpcHandler` typed
// against `CtxPreAuth`, NOT `CtxPostAuth` (codex P2-r2-1 — per-def
// narrowing). Value (not type-only) import because the F6 gate calls
// `register(Connect, …)` to exercise overload resolution.
import { Connect } from "../network/methods.js";

// Cutover-time forcing function. After impl-staff deletes the V2
// aliases (or renames them), the import block above must update; if
// the rename forgets a symbol, the next two lines fail to compile.
type _RpcHandlerV2Smoke = RpcHandlerV2<unknown>;
type _RpcCallErrorV2Smoke = RpcCallErrorV2;

// Smoke tests for the AC1 surface (each line fails compile if the type
// disappears from the barrel).
type _Connection = Connection<unknown>;
type _ConnectionConfig = ConnectionConfig;
type _ConnectionContext = ConnectionContext<{ readonly foo: number }>;
type _DecodedRequest = DecodedRequest;
type _HookFailure = HookFailure;
type _JsonValue = JsonValue;
type _Subscription = Subscription;
type _ServerConnection = ServerConnection<unknown>;
type _ClientConnection = ClientConnection<unknown>;
type _ConnectionRunError = ConnectionRunError;
type _RemoteTaggedError = RemoteTaggedError;

// ─── F3 gate (r2 — plan-eng P2-B) ────────────────────────────────────
// Plan-eng caught that the previous canary instantiated only
// `Connection<unknown>` etc., which compiles under BOTH the old
// single-Ctx shape AND the new split-generic-with-aliased-errors
// surface — so the canary didn't actually gate the F3 named aliases.
// Each alias must resolve to its declared composition; if the barrel
// drops an alias, the import block fails to resolve.
type _ConnectionCallError = ConnectionCallError;
type _ConnectionWriteError = ConnectionWriteError;
type _ConnectionRegisterError = ConnectionRegisterError;

// ─── F6 gate (split-generic + per-definition register narrowing) ─────
// Gate the split-generic + per-definition register narrowing.
//
// (1) `Connection` MUST accept four generic positions with
//     `CtxPostAuth extends CtxPreAuth`. The four-arg instantiation
//     below fails compile if the second generic disappears.
//     `CtxPreAuth = { pre: 1 }` and `CtxPostAuth = { pre: 1; post: 2 }`
//     deliberately differ so the split-generic is observable.
type _ConnectionSplitGeneric = Connection<
  { readonly pre: 1 },
  { readonly pre: 1; readonly post: 2 }
>;

// (1b) Negative canary — `CtxPostAuth extends CtxPreAuth` constraint
//      MUST gate the second generic. Construct an instantiation where
//      the second arg does NOT extend the first (`{pre:1}` is missing
//      `post`, so it does NOT extend `{pre:1; post:2}`). If impl-staff
//      regresses by dropping the `extends` constraint, the
//      `@ts-expect-error` becomes a type error (the line compiles
//      cleanly). Per `feedback_canaries_focus_on_live_code` (clarified):
//      negative canaries gating CURRENT-surface soundness ARE within
//      doctrine. The instantiation is collapsed to one line so the
//      `@ts-expect-error` directive (which suppresses errors on the
//      immediately FOLLOWING line only) reaches the constraint
//      violation, which TypeScript attaches to the offending type arg.
// prettier-ignore
// @ts-expect-error — second generic must extend first; this pair violates it.
type _ConnectionConstraintGate = Connection<{ readonly pre: 1; readonly post: 2 }, { readonly pre: 1 }>;

// (2) `register(Connect, h)` MUST accept an `RpcHandler` typed against
//     `CtxPreAuth` (the first generic), NOT `CtxPostAuth`. Construct a
//     fresh Connection where `CtxPreAuth ≠ CtxPostAuth` (the only case
//     where the seam is observable) and assign the PreAuth-typed
//     Connect handler to the register parameter. If impl-staff
//     regresses to a single global cast (the F6-broken shape codex
//     caught), the overload binds Connect to `CtxPostAuth` and the
//     assignment fails compile.
import type { Effect } from "effect";
declare const splitConn: _ConnectionSplitGeneric;
declare const connectHandlerPreAuth: RpcHandlerV2<
  { readonly pre: 1 },
  typeof Connect
>;
// Positive — Connect must be acceptable with a PreAuth-typed handler.
const _f6RegisterAcceptsPreAuth: Effect.Effect<
  Subscription,
  ConnectionRegisterError,
  never
> = splitConn.register(Connect, connectHandlerPreAuth);

// Negative canary (P2-r3 — register-overload leakage gate).
// `register(Connect, …)` MUST reject a `RpcHandler` typed against
// `CtxPostAuth`. The leakage that motivates this gate: a global cast
// or a non-narrowed default overload accepts the post-auth handler
// for the `Connect` definition, and the dispatcher's pre-auth call
// path then deref's `ctx.auth.userId` at runtime → NPE. The single
// conditional-typed `register` signature closes the seam — when D
// resolves to `typeof Connect`, the handler slot's conditional
// requires `RpcHandler<CtxPreAuth, D>`, and `RpcHandler<CtxPostAuth, D>`
// is rejected under handler contravariance in `Ctx`. If impl-staff
// regresses (single global cast, or a default overload that doesn't
// exclude `Connect`), this `@ts-expect-error` becomes a type error.
declare const connectHandlerPostAuth: RpcHandlerV2<
  { readonly pre: 1; readonly post: 2 },
  typeof Connect
>;
// prettier-ignore
// @ts-expect-error — register(Connect, postAuthHandler) must NOT type-check.
const _f6RejectsConnectWithPostAuth = splitConn.register(Connect, connectHandlerPostAuth);

// (3) The non-Connect ("default") overload MUST bind the handler's ctx
//     to `CtxPostAuth`. `Parameters<typeof X>` returns the LAST
//     overload's parameter list — by convention the default overload
//     is declared second. If impl-staff regresses to a single-Ctx
//     register signature OR if the default overload's `Ctx` is the
//     same as the Connect overload's, the inferred `_DefaultHandlerCtx`
//     fails the bidirectional assignability check below.
type _DefaultHandlerParam = Parameters<typeof splitConn.register>[1];
type _DefaultHandlerCtx =
  _DefaultHandlerParam extends RpcHandlerV2<infer Ctx, infer _D> ? Ctx : never;
type _PostAuthShape = { readonly pre: 1; readonly post: 2 };
// Bidirectional assignability — `_DefaultHandlerCtx` must equal the
// CtxPostAuth shape, not the CtxPreAuth shape. `declare const` keeps
// the smoke type-only (no opaque double-cast — agent-code-guard
// rejects those even in canary files).
declare const _f6DefaultBindsPostAuth: _DefaultHandlerCtx;
declare const _f6PostAuthBindsDefault: _PostAuthShape;
const _f6DefaultIsPostAuth: _PostAuthShape = _f6DefaultBindsPostAuth;
const _f6PostAuthIsDefault: _DefaultHandlerCtx = _f6PostAuthBindsDefault;

// Touch the bindings so unused-var elision doesn't trim them.
export const _f6GateAssert = [
  _f6RegisterAcceptsPreAuth,
  _f6RejectsConnectWithPostAuth,
  _f6DefaultIsPostAuth,
  _f6PostAuthIsDefault,
] as const;

// Reference-only — silences unused-type warnings while preserving the
// canary semantics. The intersection forces TS to flatten every member
// type; any structural drift fails here.
export type _AC1Canary =
  | _RpcHandlerV2Smoke
  | _RpcCallErrorV2Smoke
  | _Connection
  | _ConnectionConfig
  | _ConnectionContext
  | _DecodedRequest
  | _HookFailure
  | _JsonValue
  | _Subscription
  | _ServerConnection
  | _ClientConnection
  | _ConnectionRunError
  | _RemoteTaggedError
  | _ConnectionCallError
  | _ConnectionWriteError
  | _ConnectionRegisterError
  | _ConnectionSplitGeneric
  | _ConnectionConstraintGate;
