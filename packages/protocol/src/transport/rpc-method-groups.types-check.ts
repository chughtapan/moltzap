/**
 * @file Type canaries for the additive `@effect/rpc` `RpcGroup` construction
 * (`transport/rpc-method-groups.ts`).
 *
 * The groups are built ahead of the native-engine cutover and are wired to no
 * dispatcher yet. These canaries are the groups' live type consumer (so the
 * unused-export pass does not flag the exports dead) AND the documented
 * invariants the build guarantees:
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
import {
  ServerRpcGroup,
  AppCallbackRpcGroup,
  AgentClientRpcGroup,
  AppCallableRpcGroup,
} from "./rpc-method-groups.js";
import type { JsonRpcMethod } from "./wire.js";

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

// Canary 1: the four group exports are non-empty `RpcGroup`s.
//
// Live type references to each export. A regression that built an empty group
// (no catalog members) collapses `MemberOf` to `never`, flipping each `IsNever`
// assertion to `true`.
type _N1 = Expect<Equal<IsNever<MemberOf<typeof ServerRpcGroup>>, false>>;
type _N2 = Expect<Equal<IsNever<MemberOf<typeof AppCallbackRpcGroup>>, false>>;
type _N3 = Expect<Equal<IsNever<MemberOf<typeof AgentClientRpcGroup>>, false>>;
type _N4 = Expect<Equal<IsNever<MemberOf<typeof AppCallableRpcGroup>>, false>>;

// Canary 2: per-tag payload correlation survives the catalog map.
//
// `dispatch/authorize` carries the `DispatchAuthorize` context payload, whose
// `attempt` field is unique to it among the callback members: `messages/authorize`
// and `task/create` carry no `attempt`. Selecting the member by tag and reading
// its payload type therefore yields THIS method's payload, not a union across
// the catalog. If the group's member type widened to a single element (the
// failure mode when the construction loses per-slot types), `MemberWithTag`
// either collapses to `never` (flipping `_C0` to `true`) or returns a payload
// whose `attempt` is absent or non-`number` (failing `_C1`).
type DispatchAuthorizeMember = MemberWithTag<
  typeof AppCallbackRpcGroup,
  "dispatch/authorize"
>;
type _C0 = Expect<Equal<IsNever<DispatchAuthorizeMember>, false>>;
type _C1 = Expect<
  Equal<
    Pick<PayloadTypeOf<DispatchAuthorizeMember>, "attempt">,
    { readonly attempt: number }
  >
>;
