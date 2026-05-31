import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import type { RpcDefinition } from "./method.js";
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
const WireErrorSchema = Schema.Struct({
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
 * Build the `@effect/rpc` `RpcGroup` for one per-kind descriptor catalog. Each
 * `defineRpc` descriptor maps to an `Rpc.make` whose payload and success are
 * the descriptor's Effect `Schema`s verbatim and whose error is the shared
 * {@link WireErrorSchema} envelope; the descriptor's branded wire `name`
 * becomes the member tag.
 *
 * The members are derived by mapping the catalog rather than hand-listing each
 * method. `Array.prototype.map` erases the input tuple to an element array, so
 * the resulting group's member type widens to a single union member whose
 * payload and success Schemas are the union across the catalog. The RUNTIME
 * members are faithful — one `Rpc` per descriptor, each carrying its own
 * `payloadSchema`/`successSchema` — only the static per-tag payload/success
 * correlation is union-collapsed. The native-engine cutover that binds
 * handlers via `RpcGroup.toLayer` recovers per-tag types at that seam.
 */
const groupFromCatalog = (defs: readonly AnyRpcDefinition[]) =>
  RpcGroup.make(
    ...defs.map((definition) =>
      Rpc.make(definition.name, {
        payload: definition.paramsSchema,
        success: definition.resultSchema,
        error: WireErrorSchema,
      }),
    ),
  );

/**
 * `@effect/rpc` groups for moltzap's four per-kind RPC catalogs, built from the
 * `rpc-registry.ts` descriptor arrays. The native-engine cutover (#725) binds
 * handlers onto these via `RpcGroup.toLayer` (server inbound) and derives typed
 * clients via `RpcClient.make`; the dual-endpoint demux pairs
 * {@link ServerRpcGroup} (client-to-server) with {@link AppCallbackRpcGroup}
 * (server-to-client).
 */
export const ServerRpcGroup = groupFromCatalog(serverRpcMethods);

/** Server-to-client callback group: `dispatch/authorize`, `messages/authorize`, `task/create`. */
export const AppCallbackRpcGroup = groupFromCatalog(appCallbackMethods);

/** Outbound group callable from `MoltZapAgentClient`. */
export const AgentClientRpcGroup = groupFromCatalog(agentClientRpcMethods);

/** Outbound group callable from an app connection: superset of the agent-client group. */
export const AppCallableRpcGroup = groupFromCatalog(appCallableRpcMethods);
