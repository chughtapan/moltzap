/**
 * @file Type canaries for the additive `@effect/rpc` `RpcGroup` construction
 * (`transport/rpc-method-groups.ts`).
 *
 * The groups are built ahead of the #725 native-engine cutover and are wired to
 * no dispatcher yet. These canaries are the groups' live type consumer (so the
 * unused-export pass does not flag the exports dead) AND the documented
 * invariant: every group is a non-empty `RpcGroup` whose members carry the
 * `WireErrorSchema` envelope as their error Schema.
 *
 * The file is compiled by the package's standard `tsc` pass (no separate
 * script). A positive canary wraps an `Equal` comparison in `Expect`, which
 * fails with TS2344 when the two sides diverge; a bare `Equal` with no `Expect`
 * wrapper pins nothing.
 *
 * The member type is a single union member (payload and success widen across
 * the catalog) because `groupFromCatalog` maps the catalog tuple with
 * `Array.prototype.map`. Per-tag payload and success correlation is recovered
 * at the `RpcGroup.toLayer` seam in the cutover, so these canaries pin the
 * error-channel and non-emptiness invariants the additive build can guarantee,
 * not per-tag payload shapes.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Schema } from "effect";
import {
  ServerRpcGroup,
  AppCallbackRpcGroup,
  AgentClientRpcGroup,
  AppCallableRpcGroup,
} from "./rpc-method-groups.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type MemberOf<G> = G extends RpcGroup.RpcGroup<infer R> ? R : never;
type IsNever<T> = [T] extends [never] ? true : false;
type ErrorSchemaOf<R> =
  R extends Rpc.Rpc<infer _Tag, infer _Payload, infer _Success, infer Error>
    ? Error
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

// Canary 2: members carry the `{ code, message, data? }` wire-error envelope.
//
// The error Schema decodes to the `WireError` shape `transport/dispatch.ts →
// wireErrorFromInstance` projects every registered tagged-error instance onto.
// Dropping a field (e.g. `data`) breaks the wire-error registry round trip the
// native engine relies on. Asserted on the callback group's member; every group
// shares the same envelope.
type _E1 = Expect<
  Equal<
    Schema.Schema.Type<ErrorSchemaOf<MemberOf<typeof AppCallbackRpcGroup>>>,
    {
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    }
  >
>;
