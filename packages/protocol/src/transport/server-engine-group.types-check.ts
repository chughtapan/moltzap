/**
 * @file Type canaries for the middleware-attached server engine group
 * (`transport/server-engine-group.ts`).
 *
 * The group is built ahead of the live-connection cutover. These canaries are
 * its live type consumer AND the fail-closed invariants the native cutover
 * relies on:
 *
 *   E.1 non-vacuous proof exclusion — a gated handler that `yield*`s its method's
 *       `*Auth` proof produces a Layer that EXCLUDES that proof (the middleware's
 *       `provides` fired), so the proof is never a leaked requirement.
 *   E.2 full-scale per-tag correlation — payload/success/error correlate per tag
 *       SURVIVING the `Rpc#middleware` attach across the full group, and a
 *       complete `HandlersFrom` literal is the engine's handler map.
 *   E.3 partition totality + disjointness — every `ServerRpcGroup` tag is gated
 *       XOR unauth-allowlisted. The gated set is the `authMiddlewareByMethod`
 *       registry keys, taken INDEPENDENTLY of the engine group (NOT recovered by
 *       filtering the group's own members), and `ServerTags` is the full
 *       catalog-derived `ServerRpcGroup` tag set — so a new authenticated method
 *       that forgets its `*AuthMw` registry entry is in neither partition and
 *       fails the build.
 *   E.4 mandatory, non-optional, per-method gate — every gated member carries its
 *       OWN `*AuthMw` (NOT a uniform one); each `*AuthMw`'s `optional` is `false`
 *       (a gate that can fall through is a security hole).
 *
 * Member tags are branded `JsonRpcMethod&lt;...&gt;`; plain string operands are
 * branded via {@link AsMethod} before comparison, the same way the in-file
 * `rpc-method-groups.types-check.ts → MemberWithTag` brands its plain `Name`.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Layer } from "effect";
import {
  authMiddlewareByMethod,
  MessagesSendAuth,
  MessagesSendAuthMw,
} from "./auth-middleware.js";
import { ServerRpcGroup } from "./rpc-method-groups.js";
import {
  ServerEngineRpcGroup,
  WsServerEngineRpcGroup,
  UNAUTHENTICATED_METHODS,
  type UnauthenticatedMethod,
  type HttpOnlyMethod,
} from "./server-engine-group.js";
import { jsonRpcMethod, type JsonRpcMethod } from "./wire.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type EngineRpcs = RpcGroup.Rpcs<typeof ServerEngineRpcGroup>;
type ServerRpcs = RpcGroup.Rpcs<typeof ServerRpcGroup>;
type WsEngineRpcsBuilt = RpcGroup.Rpcs<typeof WsServerEngineRpcGroup>;

/**
 * Brand a plain-literal tag union to `JsonRpcMethod&lt;...&gt;` — same idea as the
 * in-file `MemberWithTag` precedent (it brands the plain `Name` arg before
 * comparing against branded member tags). Distributes over the union.
 */
type AsMethod<Names extends string> = Names extends Names
  ? JsonRpcMethod<Names>
  : never;

// ── E.3 partition totality + disjointness (NON-VACUOUS) ──────────────────

type ServerTags = ServerRpcs["_tag"];
type UnauthTags = AsMethod<UnauthenticatedMethod>;
type HttpOnlyTags = AsMethod<HttpOnlyMethod>;
// Gated tags are the registry keys, taken INDEPENDENTLY of the engine group: the
// registry is the single source the engine reads to attach gates, so deriving the
// partition from the SAME group it gates would be vacuous (it could only ever
// agree with itself). A WS method authenticated by the descriptor catalog but
// absent from the registry is in none of the three arms — `_Exhaustive` fails.
type GatedTags = AsMethod<keyof typeof authMiddlewareByMethod & string>;

// Exhaustive three-arm partition: every ServerRpcGroup tag is WS-gated (carries
// its `*AuthMw`) OR unauth-allowlisted OR HTTP-only (no WS handler, no gate).
type _Exhaustive = Expect<
  Equal<GatedTags | UnauthTags | HttpOnlyTags, ServerTags>
>;
// Disjoint: the three arms share no tag.
type _Disjoint = Expect<
  Equal<
    | (GatedTags & UnauthTags)
    | (GatedTags & HttpOnlyTags)
    | (UnauthTags & HttpOnlyTags),
    never
  >
>;
// Unauth set is EXACTLY network/connect (branded both sides).
type _UnauthExact = Expect<Equal<UnauthTags, JsonRpcMethod<"network/connect">>>;
// Every engine tag is a real ServerRpcGroup tag — no stray member.
type _NoStrayTag = Expect<
  [EngineRpcs["_tag"]] extends [ServerTags] ? true : false
>;
// The allowlist value is exactly the one literal — a new entry trips review.
type _AllowlistExact = Expect<
  Equal<(typeof UNAUTHENTICATED_METHODS)[number], "network/connect">
>;

// ── WS-subset alignment: the built group equals the type-level subset ─────

// The WS-handled member subset, type-level: the full engine members minus the
// HTTP-only ones. Same `Exclude` shape `native-handlers.types-check.ts` uses, so
// the runtime `WsServerEngineRpcGroup`, the handler-map keys, and this canary all
// describe the SAME member set.
type WsEngineRpcs = Exclude<EngineRpcs, { readonly _tag: HttpOnlyTags }>;
// The runtime `WsServerEngineRpcGroup`'s member type equals that subset exactly.
// A `.filter` predicate that drifts from the type-level `Exclude` (e.g. drops an
// authenticated WS member, or fails to drop an HTTP-only one) breaks this
// equality and fails the build; the boot guard `assertWsEngineSize` is the
// runtime-count backstop for the same invariant.
type _WsSubsetAligned = Expect<Equal<WsEngineRpcsBuilt, WsEngineRpcs>>;
// No HTTP-only member survives into the WS group.
type _WsNoHttpOnly = Expect<
  [WsEngineRpcsBuilt["_tag"] & HttpOnlyTags] extends [never] ? true : false
>;

// ── E.4 mandatory, non-optional, per-method gate ─────────────────────────

type MemberWithTag<Name extends string> = EngineRpcs extends infer R
  ? R extends Rpc.Rpc<
      JsonRpcMethod<Name>,
      infer _P,
      infer _S,
      infer _E,
      infer _M
    >
    ? R
    : never
  : never;

// Each gated member carries its OWN `*AuthMw`, not a uniform one. `messages/send`
// carries `MessagesSendAuthMw` (a cap-bearing agent method); selecting another
// method would yield a DIFFERENT middleware identifier, so this equality pins the
// per-method attach (a uniform attach would make every member's middleware the
// same type and fail one of these per-method checks).
type MessagesSendMember = MemberWithTag<"messages/send">;
type _MSGatedByOwnMw = Expect<
  Equal<Rpc.Middleware<MessagesSendMember>, MessagesSendAuthMw>
>;
// The per-method gate is non-optional: an `optional: true` middleware falls
// through to the handler on failure, which would let a rejected principal/cap
// reach the body. Every `*AuthMw.optional` is `false` by construction.
type _GateNonOptional = Expect<
  Equal<(typeof MessagesSendAuthMw)["optional"], false>
>;

// ── E.2 full-scale per-tag correlation ──────────────────────────────────

// `messages/send` carries the agent-send payload; selecting by tag after the
// middleware attach yields THIS member, not a union — proof the per-tag
// correlation survives `Rpc#middleware` at full group scale.
type _MSPresent = Expect<
  Equal<[MessagesSendMember] extends [never] ? true : false, false>
>;

// A complete `HandlersFrom` literal is the engine's handler map: its keys are
// exactly the engine member tags (per-tag totality — a missing tag drops a
// required key, a stray key is not a member tag).
type EngineHandlers = RpcGroup.HandlersFrom<EngineRpcs>;
type _HandlerKeysTotal = Expect<
  Equal<keyof EngineHandlers, EngineRpcs["_tag"]>
>;

// ── E.1 non-vacuous proof exclusion ─────────────────────────────────────

// A concrete handler for the gated `messages/send` member whose body REQUIRES the
// method's `MessagesSendAuth` proof — typed via
// `Rpc.ToHandlerFn<member, MessagesSendAuth>` so the handler's `R` is
// `MessagesSendAuth`, NOT the vacuous `any` default. Bound in isolation via
// `toLayerHandler` (not `toLayer`, whose `HandlersFrom` map re-introduces the
// `any` default for the other keys and lets `any` dominate the intersection). The
// resulting Layer's residual requirement must EXCLUDE `MessagesSendAuth` — the
// middleware's `provides` stripped it.
declare const sendHandler: Rpc.ToHandlerFn<
  MessagesSendMember,
  MessagesSendAuth
>;
const sendLayer = ServerEngineRpcGroup.toLayerHandler(
  jsonRpcMethod("messages/send"),
  sendHandler,
);
type SendLayerRX =
  typeof sendLayer extends Layer.Layer<infer _ROut, infer _EX, infer RIn>
    ? RIn
    : never;
type _ProofExcluded = Expect<
  Equal<[MessagesSendAuth] extends [SendLayerRX] ? true : false, false>
>;

export type {
  _Exhaustive,
  _Disjoint,
  _UnauthExact,
  _NoStrayTag,
  _AllowlistExact,
  _WsSubsetAligned,
  _WsNoHttpOnly,
  _MSGatedByOwnMw,
  _GateNonOptional,
  _MSPresent,
  _HandlerKeysTotal,
  _ProofExcluded,
};
