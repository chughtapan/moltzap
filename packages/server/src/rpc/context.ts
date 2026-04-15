export type AuthenticatedContext =
  | {
      kind: "user";
      userId: string;
      activeAgentId: string | null;
    }
  | {
      kind: "agent";
      agentId: string;
      agentStatus: string;
      ownerUserId: string | null;
    };

export type RpcHandler = (
  params: unknown,
  ctx: AuthenticatedContext,
) => Promise<unknown>;

export interface RpcMethodDef {
  handler: RpcHandler;
  validator?: (params: unknown) => boolean;
  requiresActive?: boolean;
}

export type RpcMethodRegistry = Record<string, RpcMethodDef>;

/**
 * Type-safe RPC method definition helper.
 *
 * Usage:
 *   defineMethod<MessagesSendParams>({
 *     validator: validators.messagesSendParams,
 *     handler: async (params, ctx) => { ... },  // params is MessagesSendParams
 *   })
 *
 * The explicit type parameter ensures the handler's params match the schema type.
 * The validator provides runtime validation; the type parameter provides compile-time safety.
 */
export function defineMethod<TParams>(def: {
  validator: (data: unknown) => boolean;
  handler: (params: TParams, ctx: AuthenticatedContext) => Promise<unknown>;
  requiresActive?: boolean;
}): RpcMethodDef {
  return def as unknown as RpcMethodDef;
}
