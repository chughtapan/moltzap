/**
 * @file Type canaries for the middleware-attached server engine group
 * (`transport/server-engine-group.ts`).
 *
 * The group is built ahead of the live-connection cutover. These canaries are
 * its live type consumer AND the fail-closed invariants the native cutover
 * relies on:
 *
 *   E.1 non-vacuous principal exclusion — a gated handler that `yield*`s
 *       `CurrentPrincipal` produces a Layer that EXCLUDES `CurrentPrincipal`
 *       (the middleware's `provides` fired), so the principal is never a leaked
 *       requirement.
 *   E.2 full-scale per-tag correlation — payload/success/error correlate per
 *       tag SURVIVING the `Rpc#middleware` attach across the full group, and a
 *       complete `HandlersFrom` literal is the engine's handler map.
 *   E.3 partition totality + disjointness — every `ServerRpcGroup` tag is gated
 *       XOR unauth-allowlisted; the unauth set is EXACTLY `network/connect`. A
 *       new authenticated method that forgets the gate is in neither partition,
 *       failing the build.
 *   E.4 mandatory, non-optional gate — every gated member carries
 *       `PrincipalResolution`; the descriptor's `optional` is `false` (a gate
 *       that can fall through is a security hole).
 *
 * Member tags are branded `JsonRpcMethod&lt;...&gt;`; plain string operands are
 * branded via {@link AsMethod} before comparison, the same way the in-file
 * `rpc-method-groups.types-check.ts → MemberWithTag` brands its plain `Name`.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Layer } from "effect";
import { CurrentPrincipal } from "./current-principal.js";
import { ServerRpcGroup, WireErrorSchema } from "./rpc-method-groups.js";
import {
  ServerEngineRpcGroup,
  PrincipalResolution,
  UNAUTHENTICATED_METHODS,
  type UnauthenticatedMethod,
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

/**
 * Brand a plain-literal tag union to `JsonRpcMethod&lt;...&gt;` — same idea as the
 * in-file `MemberWithTag` precedent (it brands the plain `Name` arg before
 * comparing against branded member tags). Distributes over the union.
 */
type AsMethod<Names extends string> = Names extends Names
  ? JsonRpcMethod<Names>
  : never;

// ── E.3 partition totality + disjointness ───────────────────────────────

type ServerTags = ServerRpcs["_tag"];
type UnauthTags = AsMethod<UnauthenticatedMethod>;
// Gated tags are derived from the engine group: a member carries
// `PrincipalResolution` iff `Rpc.Middleware<member>` is `PrincipalResolution`,
// which holds for every member NOT in `UNAUTHENTICATED_METHODS`.
type GatedMember = EngineRpcs extends infer R
  ? R extends Rpc.Rpc<infer _T, infer _P, infer _S, infer _E, infer _M>
    ? [Rpc.Middleware<R>] extends [never]
      ? never
      : R
    : never
  : never;
type GatedTags = GatedMember["_tag"];

// Exhaustive partition: every ServerRpcGroup tag is gated OR unauth-allowlisted.
type _Exhaustive = Expect<Equal<GatedTags | UnauthTags, ServerTags>>;
// Disjoint: no tag is both.
type _Disjoint = Expect<Equal<GatedTags & UnauthTags, never>>;
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

// ── E.4 mandatory, non-optional gate ────────────────────────────────────

// Every gated member's middleware identifier is exactly `PrincipalResolution`.
type _GatedCarryGate = Expect<
  Equal<Rpc.Middleware<GatedMember>, PrincipalResolution>
>;
// The descriptor is non-optional: an `optional: true` middleware falls through
// to the handler on failure, which would let a rejected principal reach the
// body. `PrincipalResolution.optional` is `false` by construction.
type _GateNonOptional = Expect<
  Equal<(typeof PrincipalResolution)["optional"], false>
>;

// ── E.2 full-scale per-tag correlation ──────────────────────────────────

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
type ErrorSchemaOf<R> =
  R extends Rpc.Rpc<infer _T, infer _P, infer _S, infer Error, infer _M>
    ? Error
    : never;

// `messages/send` carries the agent-send payload; selecting by tag after the
// middleware attach yields THIS member's payload, not a union — proof the
// per-tag correlation survives `Rpc#middleware` at full group scale.
type MessagesSendMember = MemberWithTag<"messages/send">;
type _MSPresent = Expect<
  Equal<[MessagesSendMember] extends [never] ? true : false, false>
>;
type _MSGated = Expect<
  Equal<Rpc.Middleware<MessagesSendMember>, PrincipalResolution>
>;
// Every member keeps the shared wire-error envelope through the attach.
type _ErrorEnvelopeSurvives = Expect<
  Equal<ErrorSchemaOf<MessagesSendMember>, typeof WireErrorSchema>
>;

// A complete `HandlersFrom` literal is the engine's handler map: its keys are
// exactly the engine member tags (per-tag totality — a missing tag drops a
// required key, a stray key is not a member tag).
type EngineHandlers = RpcGroup.HandlersFrom<EngineRpcs>;
type _HandlerKeysTotal = Expect<
  Equal<keyof EngineHandlers, EngineRpcs["_tag"]>
>;

// ── E.1 non-vacuous principal exclusion ─────────────────────────────────

// A concrete handler for the gated `messages/send` member whose body REQUIRES
// `CurrentPrincipal` — typed via `Rpc.ToHandlerFn<member, CurrentPrincipal>` so
// the handler's `R` is `CurrentPrincipal`, NOT the vacuous `any` default that
// swallowed the exclusion in the 3a canary. Bound in isolation via
// `toLayerHandler` (not `toLayer`, whose `HandlersFrom` map re-introduces the
// `any` default for the other keys and lets `any` dominate the intersection).
// The resulting Layer's residual requirement must EXCLUDE `CurrentPrincipal` —
// the middleware's `provides` stripped it (`HandlerContext`'s `ExcludeProvides`).
declare const sendHandler: Rpc.ToHandlerFn<
  MessagesSendMember,
  CurrentPrincipal
>;
const sendLayer = ServerEngineRpcGroup.toLayerHandler(
  jsonRpcMethod("messages/send"),
  sendHandler,
);
type SendLayerRX =
  typeof sendLayer extends Layer.Layer<infer _ROut, infer _EX, infer RIn>
    ? RIn
    : never;
type _PrincipalExcluded = Expect<
  Equal<[CurrentPrincipal] extends [SendLayerRX] ? true : false, false>
>;

export type {
  _Exhaustive,
  _Disjoint,
  _UnauthExact,
  _NoStrayTag,
  _AllowlistExact,
  _GatedCarryGate,
  _GateNonOptional,
  _MSPresent,
  _MSGated,
  _ErrorEnvelopeSurvives,
  _HandlerKeysTotal,
  _PrincipalExcluded,
};
