/**
 * @file Type canaries for the middleware-attached server engine group
 * (`transport/server-engine-group.ts`).
 *
 * These canaries are the group's live type consumer AND the fail-closed
 * invariants it relies on:
 *
 *   E.1 non-vacuous proof exclusion — a gated handler that `yield*`s its method's
 *       `*Auth` proof produces a Layer that EXCLUDES that proof (the middleware's
 *       `provides` fired), so the proof is never a leaked requirement.
 *   E.2 full-scale per-tag correlation — payload/success/error correlate per tag
 *       SURVIVING the `Rpc#middleware` attach across the full group, and a
 *       complete `HandlersFrom` literal is the engine's handler map.
 *   E.3 partition totality + disjointness — every catalog tag is gated XOR
 *       unauth-allowlisted XOR HTTP-only. `ServerTags` is the full
 *       catalog-derived `ServerEngineRpcGroup` tag set, so a new authenticated
 *       method that forgets its `*AuthMw` registry entry is in neither the gated
 *       nor the allowlisted arm and fails the build.
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
import { PrincipalGateMw } from "./cap-middlewares.js";
import { ConversationInTask } from "../task/capabilities/index.js";
import {
  ServerEngineRpcGroup,
  WsServerEngineRpcGroup,
  UNAUTHENTICATED_METHODS,
  type UnauthenticatedMethod,
} from "./server-engine-group.js";
import { jsonRpcMethod, type JsonRpcMethod } from "../transport/wire.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type EngineRpcs = RpcGroup.Rpcs<typeof ServerEngineRpcGroup>;
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

type ServerTags = EngineRpcs["_tag"];
type UnauthTags = AsMethod<UnauthenticatedMethod>;
// Every authenticated method is gated by construction: `buildEngineMember`
// stacks `PrincipalGateMw` + the declared caps' middlewares on every tag NOT in
// the unauth allowlist. The gated arm is therefore the catalog minus the
// allowlist; the partition's job is to pin that the allowlist is exact and
// disjoint, and the boot guard `findEngineGatingMismatch` is the runtime backstop
// that each gated member carries the principal gate + its declared cap mws.
type GatedTags = Exclude<ServerTags, UnauthTags>;

// Exhaustive two-arm partition: every catalog tag is WS-gated (carries its
// `*AuthMw`) OR unauth-allowlisted.
type _Exhaustive = Expect<Equal<GatedTags | UnauthTags, ServerTags>>;
// Disjoint: the two arms share no tag.
type _Disjoint = Expect<Equal<GatedTags & UnauthTags, never>>;
// Unauth set is EXACTLY network/connect (branded both sides).
type _UnauthExact = Expect<Equal<UnauthTags, JsonRpcMethod<"network/connect">>>;
// Every engine tag is a real catalog tag — no stray member.
type _NoStrayTag = Expect<
  [EngineRpcs["_tag"]] extends [ServerTags] ? true : false
>;
// The allowlist value is exactly the one literal — a new entry trips review.
type _AllowlistExact = Expect<
  Equal<(typeof UNAUTHENTICATED_METHODS)[number], "network/connect">
>;

// ── WS-group alignment: the built group equals the catalog group ──────────

// Every catalog method is WS-dispatched, so the WS group's member set is the
// full engine member set. The runtime `WsServerEngineRpcGroup`'s member type
// equals that exactly; a construction drift (drops or duplicates a member) breaks
// this equality and fails the build, and the boot guard `assertWsEngineSize` is
// the runtime-count backstop for the same invariant.
type _WsSubsetAligned = Expect<Equal<WsEngineRpcsBuilt, EngineRpcs>>;

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

// The principal gate is stacked on every authenticated member and is
// non-optional: an `optional: true` middleware falls through to the handler on
// failure, which would let a rejected principal reach the body.
type MessagesSendMember = MemberWithTag<"messages/send">;
type _GateNonOptional = Expect<
  Equal<(typeof PrincipalGateMw)["optional"], false>
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
// `ConversationInTask` cap proof — typed via
// `Rpc.ToHandlerFn<member, ConversationInTask>` so the handler's `R` is
// `ConversationInTask`, NOT the vacuous `any` default. Bound in isolation via
// `toLayerHandler` (not `toLayer`, whose `HandlersFrom` map re-introduces the
// `any` default for the other keys and lets `any` dominate the intersection). The
// resulting Layer's residual requirement must EXCLUDE `ConversationInTask` — the
// stacked `ConversationInTaskMw`'s `provides` stripped it.
declare const sendHandler: Rpc.ToHandlerFn<
  MessagesSendMember,
  ConversationInTask
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
  Equal<[ConversationInTask] extends [SendLayerRX] ? true : false, false>
>;

export type {
  _Exhaustive,
  _Disjoint,
  _UnauthExact,
  _NoStrayTag,
  _AllowlistExact,
  _WsSubsetAligned,
  _GateNonOptional,
  _MSPresent,
  _HandlerKeysTotal,
  _ProofExcluded,
};
