import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import type { RpcDefinition } from "./method.js";
import type { JsonRpcMethod } from "./wire.js";
import {
  serverRpcMethods,
  appCallbackMethods,
  agentClientRpcMethods,
  appCallableRpcMethods,
} from "../rpc-registry.js";

/**
 * The JSON-RPC error envelope every wire response carries on its `error`
 * sub-object: code, message, and optional data. This is the Schema form of the
 * `WireError` shape `transport/dispatch.ts → wireErrorFromInstance` projects a
 * registered tagged-error instance onto, so it is the `Rpc.make` error Schema
 * for every group member: the engine encodes a handler failure onto these
 * three fields, and the client side reconstructs the typed tagged error from
 * the code via `wire-errors.ts → errorClassFor`. Per-tag error narrowing stays
 * a registry concern (the `RegisteredTaggedError` union in `rpc-registry.ts`),
 * not a per-member Schema union — the wire only ever carries the coded
 * envelope.
 */
// The canonical wire-error envelope is the `error` Schema of every group
// member AND the `failure` Schema of every per-method `*AuthMw` middleware
// (`auth-middleware.ts`) — one envelope across both surfaces so a gate/cap
// rejection rides the same coded wire shape as a handler failure. Exported for
// that cross-file reuse.
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- the wire-error envelope is shared cross-file: it is every group member's `error` Schema AND every per-method `*AuthMw` `failure` Schema, so it is exported once for that reuse rather than duplicated.
export const WireErrorSchema = Schema.Struct({
  code: Schema.Number.pipe(Schema.int()),
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
>;

/**
 * The `Rpc` a single descriptor maps to: its branded wire `name` is the member
 * tag, its `paramsSchema`/`resultSchema` are payload/success verbatim, and the
 * shared {@link WireErrorSchema} envelope is the error Schema.
 */
type RpcFromDef<D> =
  D extends RpcDefinition<infer Name, infer P, infer R>
    ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, typeof WireErrorSchema>
    : never;

/**
 * The per-member tuple a catalog maps to. Homomorphic over the catalog's
 * `as const` tuple (the `[K in keyof Defs]` mapping), so each member keeps its
 * own tag/payload/success types per slot instead of widening to one union
 * element. A group built from this tuple therefore has a member type that
 * correlates each tag with its own payload/success Schemas — the shape
 * `RpcClient.make` reads to type each method, and `RpcGroup.toLayer` reads to
 * type each handler.
 */
type GroupMembers<Defs extends readonly AnyRpcDefinition[]> = {
  readonly [K in keyof Defs]: RpcFromDef<Defs[K]>;
};

/**
 * Build the `@effect/rpc` `RpcGroup` for one per-kind descriptor catalog. Each
 * `defineRpc` descriptor maps to an `Rpc.make` whose payload and success are
 * the descriptor's Effect `Schema`s verbatim and whose error is the shared
 * {@link WireErrorSchema} envelope; the descriptor's branded wire `name`
 * becomes the member tag.
 *
 * Members are derived by mapping the catalog rather than hand-listing each
 * method, so the group can never drift from `rpc-registry.ts`. {@link
 * GroupMembers} re-types the mapped result as the per-slot tuple so each
 * member's tag/payload/success correlation survives for downstream
 * `RpcClient.make` / `RpcGroup.toLayer`.
 */
const groupFromCatalog = <const Defs extends readonly AnyRpcDefinition[]>(
  defs: Defs,
): RpcGroup.RpcGroup<GroupMembers<Defs>[number]> =>
  RpcGroup.make(
    // `Array.prototype.map` is typed to return a homogeneous element array;
    // TypeScript alone cannot prove it preserves the catalog's tuple length.
    // At runtime it yields exactly one `Rpc` per descriptor in source order,
    // which is precisely the per-slot tuple `GroupMembers<Defs>` describes, so
    // the assertion is sound. The per-tag tag↔payload correlation it claims is
    // type-verified by `rpc-method-groups.types-check.ts` (the group stops
    // compiling there if the mapped type drifts).
    ...(defs.map((definition) =>
      Rpc.make(definition.name, {
        payload: definition.paramsSchema,
        success: definition.resultSchema,
        error: WireErrorSchema,
      }),
    ) as GroupMembers<Defs>),
  );

/**
 * `@effect/rpc` groups for moltzap's four per-kind RPC catalogs, built from the
 * `rpc-registry.ts` descriptor arrays. The native-engine cutover binds handlers
 * onto these via `RpcGroup.toLayer` (server inbound) and derives typed clients
 * via `RpcClient.make`; the dual-endpoint demux pairs {@link ServerRpcGroup}
 * (client-to-server) with {@link AppCallbackRpcGroup} (server-to-client).
 */
export const ServerRpcGroup = groupFromCatalog(serverRpcMethods);

/** Server-to-client callback group: `dispatch/authorize`, `messages/authorize`, `task/create`. */
export const AppCallbackRpcGroup = groupFromCatalog(appCallbackMethods);

/** Outbound group callable from `MoltZapAgentClient`. */
export const AgentClientRpcGroup = groupFromCatalog(agentClientRpcMethods);

/** Outbound group callable from an app connection: superset of the agent-client group. */
export const AppCallableRpcGroup = groupFromCatalog(appCallableRpcMethods);
