import type { Effect } from "effect";
import type { RpcDefinition, Static, TSchema } from "@moltzap/protocol";
import type { RpcFailure } from "../runtime/index.js";
import type { ConnIdTag } from "../app/layers.js";

export interface AuthenticatedContext {
  agentId: string;
  agentStatus: string;
  ownerUserId: string | null;
}

/**
 * RPC handler program. Executes as an Effect that may fail with a typed
 * `RpcFailure` (mapped 1:1 to a wire error frame) or die with a defect
 * (mapped to `InternalError` at the router edge).
 *
 * Requires `ConnIdTag` from the Context — the router provides it via
 * `Effect.provideService(ConnIdTag, connId)` before running the handler.
 */
export type RpcHandler = (
  params: unknown,
  ctx: AuthenticatedContext,
) => Effect.Effect<unknown, RpcFailure, ConnIdTag>;

export interface RpcMethodDef {
  handler: RpcHandler;
  validator?: (params: unknown) => boolean;
  requiresActive?: boolean;
}

export type RpcMethodRegistry = Record<string, RpcMethodDef>;

/**
 * Type-safe RPC method definition driven by a protocol manifest.
 *
 *     defineMethod(AgentsLookupByName, {
 *       handler: (params, ctx) => ...  // params typed from manifest schema
 *     })
 *
 * The validator and param/result types are derived from the `RpcDefinition` —
 * a method key ("agents/lookupByName") can't drift away from its validator
 * or its TypeScript types because all three come from the same manifest
 * object.
 */
export function defineMethod<D extends RpcDefinition<string, TSchema, TSchema>>(
  definition: D,
  def: {
    handler: (
      params: Static<D["paramsSchema"]>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<D["resultSchema"]>, RpcFailure, ConnIdTag>;
    requiresActive?: boolean;
  },
): RpcMethodDef {
  return {
    validator: definition.validateParams,
    ...(def.requiresActive ? { requiresActive: true } : {}),
    handler: def.handler as RpcHandler,
  };
}
