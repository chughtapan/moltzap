/**
 * @file The two client-facing `RpcGroup` projections of the `serverRpcMethods`
 * catalog, partitioned by each descriptor's principal requirement (the head of
 * its `requires` list).
 *
 * A first-party client knows its own principal at construction time, so an app
 * calling an agent-only RPC (or vice versa) should be a COMPILE error, not a
 * runtime `ForbiddenError` discovered in production. `agent-client.ts` types
 * against {@link AgentCallableGroup}; `app-client.ts` against
 * {@link AppCallableGroup}. The runtime principal gate (each method's principal
 * requirement middleware) stays as the untrusted-peer backstop; these groups are
 * the first-party compile-time layer ON TOP of it.
 *
 * Single source: the partition reads each descriptor's `requires` head (the same
 * principal requirement the server gate narrows to), so the client bound and the
 * server gate cannot drift.
 *
 * Methods with an empty `requires` (only `network/connect`) appear in BOTH
 * groups: an unauthenticated method is callable from either client pre-auth.
 */
import { Rpc, RpcGroup } from "@effect/rpc";
import type { Schema } from "effect";
import type { RpcDefinition } from "../transport/method.js";
import { AgentPrincipal, AppPrincipal } from "../transport/principal.js";
import {
  type Requirement,
  type PrincipalRequirement,
  type PrincipalRequirementOf,
  principalRequirementOf,
} from "./requirements.js";
import type { JsonRpcMethod } from "../transport/wire.js";
import { serverRpcMethods } from "../rpc-registry.js";

// The engine partitions the live catalog descriptors, whose `requires` are
// built from the concrete requirement tags. The wire-layer `RpcDefinition`
// erases `requires` to the structural `RequirementShape`; re-pin the 4th type
// arg to the genuine `Requirement` union so `PrincipalRequirementOf` /
// `principalRequirementOf` read the concrete head tag.
type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext,
  ReadonlyArray<Requirement>
>;

/**
 * The `Rpc` a single descriptor maps to — identical to
 * {@link rpc-method-groups.RpcFromDef} (the member tag is the descriptor's
 * branded wire `name`, payload/success are the descriptor Schemas, error is the
 * method's own `errorSchema` — its `_tag`-discriminated error union).
 */
type RpcFromDef<D> =
  D extends RpcDefinition<infer Name, infer P, infer R>
    ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, Schema.Schema.AnyNoContext>
    : never;

/**
 * Filter a catalog tuple to the members whose `requires` head is in `Heads`
 * (the principal-requirement tags this group accepts; an empty-`requires`
 * descriptor — head `undefined` — is always in, so unauthenticated methods join
 * both groups), mapping each surviving descriptor to its `Rpc`. Homomorphic over
 * the `as const` tuple: a descriptor whose head is NOT accepted maps to `never`
 * and drops out of the resulting member union, while a surviving member keeps
 * its own per-slot tag/payload/success types (no widening to one union element).
 * The membership test reads the descriptor's `requires` head
 * ({@link PrincipalRequirementOf}), so it cannot disagree with the runtime
 * `.filter`.
 */
type MembersWhereHead<
  Defs extends readonly AnyRpcDefinition[],
  Heads extends PrincipalRequirement,
> = {
  readonly [K in keyof Defs]: Defs[K] extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    infer Requires extends ReadonlyArray<Requirement>
  >
    ? PrincipalRequirementOf<Requires> extends Heads | undefined
      ? RpcFromDef<Defs[K]>
      : never
    : never;
}[number];

/**
 * Whether a descriptor's `requires` head is in the accepted set — the single
 * runtime membership check both client-group projections share with the
 * type-level {@link MembersWhereHead} filter. An empty-`requires` descriptor
 * (head `undefined`) is always callable.
 */
const callableBy = (
  definition: AnyRpcDefinition,
  heads: readonly PrincipalRequirement[],
): boolean => {
  const head = principalRequirementOf(definition.requires);
  return head === undefined || heads.includes(head);
};

/**
 * Build one client-callable group from the `serverRpcMethods` catalog filtered
 * by accepted `requires` head. The runtime `.filter` selects the same members
 * the type-level {@link MembersWhereHead} keeps; the single sanctioned assertion
 * launders `Array.prototype.filter`/`map`'s homogeneous-return into the per-slot
 * member union the type describes (a tuple-keying proof TS cannot express,
 * verified by `client-callable-groups.types-check.ts`).
 */
const callableGroup = <Heads extends PrincipalRequirement>(
  heads: readonly Heads[],
): RpcGroup.RpcGroup<MembersWhereHead<typeof serverRpcMethods, Heads>> =>
  RpcGroup.make(
    // `Array.prototype.filter`/`map` are typed to a homogeneous element array;
    // TS cannot prove the result is the per-slot member union `MembersWhereHead`
    // describes. At runtime it yields exactly the descriptors whose `requires`
    // head is accepted, mapped to one `Rpc` each — precisely that union. The
    // per-tag tag↔payload correlation is type-verified by
    // `client-callable-groups.types-check.ts`.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-filter/keying proof TS cannot express; the homogeneous filter/map source does not overlap the precise per-slot member union, verified by `client-callable-groups.types-check.ts`.
    ...(serverRpcMethods
      .filter((definition) => callableBy(definition, heads))
      .map((definition) =>
        Rpc.make(definition.name, {
          payload: definition.paramsSchema,
          success: definition.resultSchema,
          error: definition.errorSchema,
        }),
      ) as unknown as MembersWhereHead<typeof serverRpcMethods, Heads>[]), // #ignore-sloppy-code[as-unknown-as]: tuple-filter/keying proof TS cannot express; verified by client-callable-groups.types-check.ts.
  );

/**
 * The outbound group a first-party AGENT client may originate: every
 * `serverRpcMethods` member whose `requires` head is `AgentPrincipal`, plus the
 * empty-`requires` methods. A first-party `agentClient.taskClose(...)`
 * (app-only) does not typecheck.
 */
export const AgentCallableGroup: RpcGroup.RpcGroup<
  MembersWhereHead<typeof serverRpcMethods, typeof AgentPrincipal>
> = callableGroup([AgentPrincipal]);

/**
 * The outbound group a first-party APP client may originate: every
 * `serverRpcMethods` member whose `requires` head is `AppPrincipal`, plus the
 * empty-`requires` methods. A first-party `appClient.taskRequest(...)`
 * (agent-only) does not typecheck — the compile-time Principle-1 win.
 */
export const AppCallableGroup: RpcGroup.RpcGroup<
  MembersWhereHead<typeof serverRpcMethods, typeof AppPrincipal>
> = callableGroup([AppPrincipal]);
