import { Context, Data, Effect, Layer } from "effect";
import { decodeRpcParams as decodeProtocolRpcParams } from "@moltzap/protocol";
import type {
  ParamsOf,
  RequestFrame,
  ResultOf,
  RpcDefinition,
  Static,
  TSchema,
} from "@moltzap/protocol";
import type { RpcFailure } from "../runtime/index.js";
import type { ConnIdTag } from "../app/layers.js";
import type { AgentId, UserId } from "../app/types.js";

export interface AuthenticatedContext {
  agentId: AgentId;
  agentStatus: string;
  ownerUserId: UserId | null;
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

export interface RpcMethodDef<
  D extends RpcDefinition<string, TSchema, TSchema>,
> {
  handler: (
    params: ParamsOf<D>,
    ctx: AuthenticatedContext,
  ) => Effect.Effect<ResultOf<D>, RpcFailure, ConnIdTag>;
  requiresActive?: boolean;
}

export class RpcMethodNotFoundError extends Data.TaggedError(
  "RpcMethodNotFoundError",
)<{
  readonly frame: RequestFrame;
}> {}

export class RpcParamsDecodeError extends Data.TaggedError(
  "RpcParamsDecodeError",
)<{
  readonly frame: RequestFrame;
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
}> {}

export type RpcResolveError = RpcMethodNotFoundError | RpcParamsDecodeError;

export interface ResolvedRpcMethod {
  readonly frame: RequestFrame;
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
  readonly requiresActive: boolean;
  readonly handle: (
    ctx: AuthenticatedContext,
  ) => Effect.Effect<unknown, RpcFailure, ConnIdTag>;
}

export interface RpcMethodBinding<
  D extends RpcDefinition<string, TSchema, TSchema> = RpcDefinition<
    string,
    TSchema,
    TSchema
  >,
> {
  readonly definition: D;
  readonly resolve: (
    frame: RequestFrame,
  ) => Effect.Effect<ResolvedRpcMethod, RpcParamsDecodeError>;
}

export type RpcMethodRegistry = RpcMethodBinding[];

export interface RpcMethodBoundaryService {
  readonly resolve: (
    frame: RequestFrame,
  ) => Effect.Effect<ResolvedRpcMethod, RpcResolveError>;
}

export class RpcMethodBoundaryTag extends Context.Tag(
  "@moltzap/server/RpcMethodBoundary",
)<RpcMethodBoundaryTag, RpcMethodBoundaryService>() {}

export function makeRpcMethodBoundaryService(
  methods: RpcMethodRegistry,
): RpcMethodBoundaryService {
  return {
    resolve: (frame) => {
      for (const binding of methods) {
        if (binding.definition.name === frame.method) {
          return binding.resolve(frame);
        }
      }
      return Effect.fail(new RpcMethodNotFoundError({ frame }));
    },
  };
}

export function makeRpcMethodBoundaryLayer(
  methods: RpcMethodRegistry,
): Layer.Layer<RpcMethodBoundaryTag> {
  return Layer.succeed(
    RpcMethodBoundaryTag,
    makeRpcMethodBoundaryService(methods),
  );
}

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
export function defineMethod<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  def: {
    handler: (
      params: Static<P>,
      ctx: AuthenticatedContext,
    ) => Effect.Effect<Static<R>, RpcFailure, ConnIdTag>;
    requiresActive?: boolean;
  },
): RpcMethodBinding<RpcDefinition<Name, P, R>> {
  return {
    definition,
    resolve: (frame) =>
      decodeProtocolRpcParams(definition, frame.params ?? {}).pipe(
        Effect.mapError(() => new RpcParamsDecodeError({ frame, definition })),
        Effect.map((params) => ({
          frame,
          definition,
          requiresActive: def.requiresActive ?? false,
          handle: (ctx: AuthenticatedContext) => def.handler(params, ctx),
        })),
      ),
  };
}
