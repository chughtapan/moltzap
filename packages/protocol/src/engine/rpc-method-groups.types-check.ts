/**
 * @file Type canaries for the reverse `@effect/rpc` `RpcGroup` construction
 * (`engine/rpc-method-groups.ts`).
 *
 * These canaries are the groups' live type consumer (so the unused-export pass
 * does not flag the exports dead) AND the documented invariants the build
 * guarantees:
 *
 *   1. every group is a non-empty `RpcGroup`;
 *   2. each member's tag correlates with its own payload Schema — the group's
 *      member type is the per-slot tuple union, not a single widened element,
 *      so `RpcClient.make` types each method and `RpcGroup.toLayer` types each
 *      handler against the right payload.
 *
 * Per-method error typing (each member's `error` Schema is the method's own
 * `_tag`-discriminated union) is recovered and asserted at the typed-client
 * surface (`@moltzap/client`), where the precise union is observable.
 *
 * The file is compiled by the package's standard `tsc` pass (no separate
 * script). A positive canary wraps an `Equal` comparison in `Expect`, which
 * fails with TS2344 when the two sides diverge; a bare `Equal` with no `Expect`
 * wrapper pins nothing.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Schema } from "effect";
import { NotificationRpcGroup, ReverseRpcGroup } from "./rpc-method-groups.js";
import type { JsonRpcMethod } from "../transport/wire.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type MemberOf<G> = G extends RpcGroup.RpcGroup<infer R> ? R : never;
type IsNever<T> = [T] extends [never] ? true : false;

// The member of group `G` whose wire name is `Name`, and that member's payload
// type. Member tags are branded `JsonRpcMethod<Name>`, so the match brands the
// plain name argument before comparing.
type MemberWithTag<G, Name extends string> =
  MemberOf<G> extends infer R
    ? R extends Rpc.Rpc<JsonRpcMethod<Name>, infer _P, infer _S, infer _E>
      ? R
      : never
    : never;
type PayloadTypeOf<R> =
  R extends Rpc.Rpc<infer _Tag, infer Payload, infer _S, infer _E>
    ? Schema.Schema.Type<Payload>
    : never;

// Canary 1: both reverse group exports are non-empty `RpcGroup`s.
//
// Live type references to each export. A regression that built an empty group
// (no catalog members) collapses `MemberOf` to `never`, flipping each `IsNever`
// assertion to `true`.
type _N1 = Expect<Equal<IsNever<MemberOf<typeof ReverseRpcGroup>>, false>>;
type _N2 = Expect<Equal<IsNever<MemberOf<typeof NotificationRpcGroup>>, false>>;

// Canary 3: `ReverseRpcGroup` is one group over the COMBINED callback ∪
// notification member tuple (not `RpcGroup.merge`), so a generic `Tag`'s success
// reduces per tag through `makeTypedTransportCall` cast-free. The construction
// asserts `... as readonly ReverseRpcMember[]`; these pin that the runtime
// members keep per-slot tag↔payload correlation across BOTH a callback and a
// notification member. A widened or merge-shaped member type collapses one of
// the `MemberWithTag` selections to `never` (flipping `_R0`/`_R2`) or returns a
// cross-member payload (failing `_R1`/`_R3`).
type ReverseDispatchMember = MemberWithTag<
  typeof ReverseRpcGroup,
  "dispatch/authorize"
>;
type _R0 = Expect<Equal<IsNever<ReverseDispatchMember>, false>>;
type _R1 = Expect<
  Equal<
    Pick<PayloadTypeOf<ReverseDispatchMember>, "attempt">,
    { readonly attempt: number }
  >
>;
type ReversePresenceMember = MemberWithTag<
  typeof ReverseRpcGroup,
  "presence/changed"
>;
type _R2 = Expect<Equal<IsNever<ReversePresenceMember>, false>>;
type _R3 = Expect<
  Equal<
    Pick<PayloadTypeOf<ReversePresenceMember>, "status">,
    { readonly status: "online" | "working" | "offline" }
  >
>;
