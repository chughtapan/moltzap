/**
 * @file Type canary for the native handler map (`native-handlers.ts`).
 *
 * The map is the engine's handler bodies for the WS-dispatched methods. These
 * canaries pin the two invariants the native cutover relies on:
 *
 *   1. key totality — the map's keys EXACTLY equal the engine group's
 *      WS-handled member tags (every `ServerEngineRpcGroup` member tag MINUS
 *      the four HTTP-only methods, which have no WS handler). A missing handler
 *      drops a required key, a stray key is not a WS member tag.
 *   2. per-tag handler shape + proof exclusion — each handler is assignable to
 *      its member's `Rpc.ToHandlerFn`, and the handler's residual requirement
 *      EXCLUDES that member's `*Auth` proof (the per-method middleware provides
 *      it, so the proof is never a leaked requirement on the bound Layer).
 *
 * `network/connect` is included (its `nativeConnect` reads the live arm via
 * `ConnectionTag`, carries no proof); the four HTTP-only methods are not.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Effect } from "effect";
import {
  ServerEngineRpcGroup,
  type UnauthenticatedMethod,
  type HttpOnlyMethod,
} from "@moltzap/protocol";
import type { JsonRpcMethod, ConversationInTask } from "@moltzap/protocol";
import { serverNativeHandlers } from "./native-handlers.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type EngineRpcs = RpcGroup.Rpcs<typeof ServerEngineRpcGroup>;

/**
 * Brand a plain-literal tag union to `JsonRpcMethod&lt;...&gt;` — the engine
 * member tags are branded, so plain operands are branded before comparison.
 */
type AsMethod<Names extends string> = Names extends Names
  ? JsonRpcMethod<Names>
  : never;

/** The four HTTP-only tags (branded), served over `http-routes.ts`, no WS handler. */
type HttpOnlyTags = AsMethod<HttpOnlyMethod>;

/**
 * The WS-handled member subset: every engine member whose tag is NOT HTTP-only.
 * `network/connect` (a {@link UnauthenticatedMethod}) stays — it has a WS
 * handler that reads no proof.
 */
type WsEngineRpcs = Exclude<EngineRpcs, { readonly _tag: HttpOnlyTags }>;

// ── 1. key totality ──────────────────────────────────────────────────────

// The map's key set equals the WS-handled member tag set. The handler keys are
// plain string literals; brand them before comparing against the branded member
// tags.
type HandlerTags = AsMethod<keyof typeof serverNativeHandlers & string>;
type _KeysCoverWsMembers = Expect<Equal<HandlerTags, WsEngineRpcs["_tag"]>>;

// The map carries no HTTP-only tag (those are served over HTTP, never WS).
type _NoHttpOnlyKey = Expect<
  [HandlerTags & HttpOnlyTags] extends [never] ? true : false
>;

// `network/connect` is a real key (the unauth WS method).
type _ConnectPresent = Expect<
  [AsMethod<UnauthenticatedMethod>] extends [HandlerTags] ? true : false
>;

// ── 2. per-tag handler shape + proof exclusion ───────────────────────────

type MemberWithTag<Name extends string> = Extract<
  EngineRpcs,
  { readonly _tag: JsonRpcMethod<Name> }
>;

/**
 * The handler's residual requirement after excluding its member's `*Auth`
 * proof — exactly what `ServerEngineRpcGroup.toLayer` puts in the bound Layer's
 * requirement channel for that tag. Reusing the engine's own `ExcludeProvides`
 * keeps the canary in lockstep with how `toLayer` types the binding.
 */
type ResidualOf<Name extends keyof typeof serverNativeHandlers & string> =
  (typeof serverNativeHandlers)[Name] extends (
    ...args: never
  ) => Effect.Effect<infer _A, infer _E, infer R>
    ? Rpc.ExcludeProvides<R, MemberWithTag<Name>, JsonRpcMethod<Name>>
    : never;

// A cap-bearing agent method: `messages/send` stacks the `ConversationInTask`
// cap middleware (among others). Its handler's residual MUST NOT contain
// `ConversationInTask` — the stacked cap middleware provides it. Mirrors
// `server-engine-group.types-check.ts` E.1 at the handler-map level.
type _SendProofExcluded = Expect<
  [ConversationInTask] extends [ResidualOf<"messages/send">] ? false : true
>;

// `network/connect` reads no proof; its handler still type-checks as a
// `ToHandlerFn` for the unauth member (no middleware, no `provides`). The
// `ToHandlerFn` `R` defaults to `any`, so this is a payload/result/error shape
// check, not a requirement check.
type _ConnectHandlerShape = Expect<
  (typeof serverNativeHandlers)["network/connect"] extends Rpc.ToHandlerFn<
    MemberWithTag<"network/connect">
  >
    ? true
    : false
>;

export type {
  _KeysCoverWsMembers,
  _NoHttpOnlyKey,
  _ConnectPresent,
  _SendProofExcluded,
  _ConnectHandlerShape,
};
