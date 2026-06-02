/**
 * @file The two client-facing `RpcGroup` projections of the `serverRpcMethods`
 * catalog, partitioned by each descriptor's `callablePrincipal` axis.
 *
 * A first-party client knows its own principal kind at construction time, so an
 * app calling an agent-only RPC (or vice versa) should be a COMPILE error, not a
 * runtime `ForbiddenError` discovered in production. `agent-client.ts` types
 * against {@link AgentCallableGroup}; `app-client.ts` against
 * {@link AppCallableGroup}. The runtime principal gate (each method's `*AuthMw`,
 * `auth-middleware.ts`) stays as the untrusted-peer backstop; these groups are
 * the first-party compile-time layer ON TOP of it.
 *
 * Single source: the partition reads each `defineRpc` descriptor's
 * `callablePrincipal` (the same axis the server gate reads), so the client bound
 * and the server gate cannot drift. The legacy coarse outbound catalogs
 * (`agentClientRpcMethods`/`appCallableRpcMethods`) are a DIFFERENT partition and
 * are retired once their consumers re-point.
 *
 * `"any"` methods (only `network/connect`) appear in BOTH groups: an
 * unauthenticated method is callable from either client pre-auth.
 */
import { Rpc, RpcGroup } from "@effect/rpc";
import type { Schema } from "effect";
import type { CallablePrincipal, RpcDefinition } from "./method.js";
import type { JsonRpcMethod } from "./wire.js";
import { serverRpcMethods } from "../rpc-registry.js";

type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
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
 * Filter a catalog tuple to the members whose `callablePrincipal` is in `Kinds`,
 * mapping each surviving descriptor to its `Rpc`. Homomorphic over the `as
 * const` tuple: a descriptor whose principal kind is NOT in `Kinds` maps to
 * `never` and drops out of the resulting member union, while a surviving member
 * keeps its own per-slot tag/payload/success types (no widening to one union
 * element). The 4th `RpcDefinition` type param IS the `callablePrincipal` axis,
 * so the membership test is type-level — it cannot disagree with the runtime
 * `.filter`.
 */
type MembersWhereKind<
  Defs extends readonly AnyRpcDefinition[],
  Kinds extends CallablePrincipal,
> = {
  readonly [K in keyof Defs]: Defs[K] extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    infer Kind
  >
    ? Kind extends Kinds
      ? RpcFromDef<Defs[K]>
      : never
    : never;
}[number];

/**
 * Whether a descriptor's `callablePrincipal` is in the given kind set — the
 * single runtime membership check both client-group projections share with the
 * type-level {@link MembersWhereKind} filter.
 */
const callableBy = (
  definition: AnyRpcDefinition,
  kinds: readonly CallablePrincipal[],
): boolean => kinds.includes(definition.callablePrincipal);

/**
 * Build one client-callable group from the `serverRpcMethods` catalog filtered
 * by principal kind. The runtime `.filter` selects the same members the
 * type-level {@link MembersWhereKind} keeps; the single sanctioned assertion
 * launders `Array.prototype.filter`/`map`'s homogeneous-return into the per-slot
 * member union the type describes (the SAME tuple-keying proof
 * {@link rpc-method-groups.groupFromCatalog} cannot express either, verified by
 * `client-callable-groups.types-check.ts`).
 */
const callableGroup = <Kinds extends CallablePrincipal>(
  kinds: readonly Kinds[],
): RpcGroup.RpcGroup<MembersWhereKind<typeof serverRpcMethods, Kinds>> =>
  RpcGroup.make(
    // `Array.prototype.filter`/`map` are typed to a homogeneous element array;
    // TS cannot prove the result is the per-slot member union `MembersWhereKind`
    // describes. At runtime it yields exactly the descriptors whose
    // `callablePrincipal` is in `kinds`, mapped to one `Rpc` each — precisely
    // that union. The per-tag tag↔payload correlation is type-verified by
    // `client-callable-groups.types-check.ts`.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-filter/keying proof TS cannot express; the homogeneous filter/map source does not overlap the precise per-slot member union, the same single assertion `groupFromCatalog` uses, verified by `client-callable-groups.types-check.ts`.
    ...(serverRpcMethods
      .filter((definition) => callableBy(definition, kinds))
      .map((definition) =>
        Rpc.make(definition.name, {
          payload: definition.paramsSchema,
          success: definition.resultSchema,
          error: definition.errorSchema,
        }),
      ) as unknown as MembersWhereKind<typeof serverRpcMethods, Kinds>[]), // #ignore-sloppy-code[as-unknown-as]: tuple-filter/keying proof TS cannot express; verified by client-callable-groups.types-check.ts.
  );

/**
 * The outbound group a first-party AGENT client may originate: every
 * `serverRpcMethods` member whose `callablePrincipal` is `"agent"` or `"any"`. A
 * first-party `agentClient.taskClose(...)` (app-only) does not typecheck.
 */
export const AgentCallableGroup: RpcGroup.RpcGroup<
  MembersWhereKind<typeof serverRpcMethods, "agent" | "any">
> = callableGroup(["agent", "any"]);

/**
 * The outbound group a first-party APP client may originate: every
 * `serverRpcMethods` member whose `callablePrincipal` is `"app"` or `"any"`. A
 * first-party `appClient.taskRequest(...)` (agent-only) does not typecheck — the
 * compile-time Principle-1 win.
 */
export const AppCallableGroup: RpcGroup.RpcGroup<
  MembersWhereKind<typeof serverRpcMethods, "app" | "any">
> = callableGroup(["app", "any"]);
