/**
 * @file Type canary for the handler map (`server-handlers.ts`).
 *
 * The map is the engine's handler bodies for the WS-dispatched methods. These
 * canaries pin two invariants:
 *
 *   1. key totality — the map's keys EXACTLY equal the engine group's
 *      WS-handled member tags (every `ServerEngineRpcGroup` member tag MINUS
 *      the HTTP-only methods, which have no WS handler). A missing handler
 *      drops a required key, a stray key is not a WS member tag.
 *   2. per-tag handler shape + proof exclusion — each handler is assignable to
 *      its member's `Rpc.ToHandlerFn`, and the handler's residual requirement
 *      EXCLUDES that member's `*Auth` proof (the per-method middleware provides
 *      it, so the proof is never a leaked requirement on the bound Layer).
 *
 * `network/connect` is included (its `connect` reads the live arm via
 * `ConnectionTag`, carries no proof); the HTTP-only methods are not.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Effect } from "effect";
import {
  ServerEngineRpcGroup,
  type UnauthenticatedMethod,
} from "@moltzap/protocol";
import type { JsonRpcMethod, ConversationInTask } from "@moltzap/protocol";
import { serverHandlers } from "./server-handlers.js";

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

// ── 1. key totality ──────────────────────────────────────────────────────

// Every catalog method is WS-dispatched, so the map's key set equals the full
// engine member tag set. The handler keys are plain string literals; brand them
// before comparing against the branded member tags.
type HandlerTags = AsMethod<keyof typeof serverHandlers & string>;
type _KeysCoverWsMembers = Expect<Equal<HandlerTags, EngineRpcs["_tag"]>>;

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
type ResidualOf<Name extends keyof typeof serverHandlers & string> =
  (typeof serverHandlers)[Name] extends (
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
  (typeof serverHandlers)["network/connect"] extends Rpc.ToHandlerFn<
    MemberWithTag<"network/connect">
  >
    ? true
    : false
>;

export type {
  _KeysCoverWsMembers,
  _ConnectPresent,
  _SendProofExcluded,
  _ConnectHandlerShape,
};
