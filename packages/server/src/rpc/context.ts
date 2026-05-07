import { Effect } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  ForbiddenError,
  handler,
  type ResultOf,
  type RpcDefinition,
  type RpcHandler,
} from "@moltzap/protocol";
import { ConnIdTag } from "../app/layers.js";
import type { AgentId, UserId } from "../app/types.js";

export interface AuthenticatedContext {
  agentId: AgentId;
  agentStatus: string;
  ownerUserId: UserId | null;
}

/** Per-request dispatch context handed to every RPC handler by JsonRpcServer. */
export interface DispatchContext {
  readonly auth: AuthenticatedContext;
  readonly connId: string;
}

/** RPC binding stored in the registry. Each binding carries a method
 * definition and a `JsonRpcServer`-compatible handler that already
 * provides the layer scopes + ConnIdTag service. */
export type RpcMethodBinding = RpcHandler<DispatchContext>;

export type RpcMethodRegistry = RpcMethodBinding[];

/** Type-safe RPC method definition driven by a protocol manifest.
 * Wraps the user's handler with `requiresActive` enforcement and
 * provides `ConnIdTag` from the dispatch context. */
export function defineMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E = never,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    handler: (
      params: Static<P>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<R>, E, ConnIdTag>;
    requiresActive?: boolean;
  },
): RpcMethodBinding {
  const requiresActive = def.requiresActive ?? false;
  return handler(definition, (params, ctx) =>
    Effect.gen(function* () {
      if (requiresActive && ctx.auth.agentStatus !== "active") {
        return yield* Effect.fail(
          new ForbiddenError({
            message: "Agent must be claimed before performing this action",
          }),
        );
      }
      // The handler returns `Static<R>`; the conditional `ResultOf<D>`
      // reduces to that, but TypeScript doesn't auto-simplify across
      // the generic boundary, so the cast bridges the equality.
      const result = yield* def
        .handler(params, ctx.auth)
        .pipe(Effect.provideService(ConnIdTag, ctx.connId));
      return result as ResultOf<RpcDefinition<Name, P, R>>;
    }),
  );
}
