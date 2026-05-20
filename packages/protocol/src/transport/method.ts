import { Data, Effect } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  ajv,
  jsonRpcMethod,
  notificationFrame,
  requestFrame,
  responseFrame,
  type JsonRpcId,
  type JsonRpcMethod,
  type NotificationFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./wire.js";
import type { CapabilityDescriptor } from "./capabilities.js";

/**
 * Typed manifest for one RPC method: wire name + schemas + validators.
 * Type-only payload accessors are exposed via `ParamsOf&lt;D>`/`ResultOf&lt;D>`
 * — there is no runtime `Params`/`Result` property.
 *
 * `capabilities` is the only optional metadata: a runtime-readable list
 * of capability descriptors the dispatcher iterates to thread
 * `Effect.provideServiceEffect`. Each descriptor names a `Context.Tag`
 * plus an `argsOf` resolver that derives the obtain helper's args from
 * `params` + `ctx`. Absent → no capabilities.
 */
export interface RpcDefinition<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly resultSchema: R;
  readonly validateParams: (data: unknown) => data is Static<P>;
  readonly validateResult: (data: unknown) => data is Static<R>;
  // `unknown` for variance compatibility with the `<string, TSchema, TSchema>`
  // supertype; concrete call sites pass typed values.
  readonly encodeRequest: (id: string, params: unknown) => RequestFrame;
  readonly encodeResponse: (
    id: JsonRpcId | null,
    result: unknown,
  ) => ResponseFrame;

  /**
   * Spec F G5/G6: per-definition capability descriptors. Each entry's
   * `tag` is a Spec E `Context.Tag` the handler will `yield*`; `argsOf`
   * is the synchronous resolver that derives the obtain helper's args
   * from `params` + `ctx`. The dispatcher reads this list at runtime
   * (not from the handler's R channel — TypeScript erases it).
   */
  readonly capabilities?: ReadonlyArray<CapabilityDescriptor>;
}

/** Type-only accessor for a definition's params payload. */
export type ParamsOf<D extends RpcDefinition<string, TSchema, TSchema>> =
  D extends RpcDefinition<string, infer P, TSchema> ? Static<P> : never;

/** Type-only accessor for a definition's result payload. */
export type ResultOf<D extends RpcDefinition<string, TSchema, TSchema>> =
  D extends RpcDefinition<string, TSchema, infer R> ? Static<R> : never;

export function defineRpc<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  Caps extends ReadonlyArray<CapabilityDescriptor> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;

  /**
   * Per-definition capability descriptors. Each entry pairs a Spec E
   * `Context.Tag` (the value the handler will `yield*`) with a
   * synchronous `argsOf` resolver that derives the obtain helper's
   * arguments from wire `params` + dispatcher `ctx`. Generic-parameterized
   * so the return type preserves the literal tuple shape for
   * `CapabilitiesOf&lt;D>`.
   */
  capabilities?: Caps;
}): RpcDefinition<Name, P, R> & {
  readonly capabilities: Caps;
} {
  const d: RpcDefinition<Name, P, R> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    resultSchema: def.result,
    validateParams: ajv.compile(def.params),
    validateResult: ajv.compile(def.result),
    encodeRequest: (id, params) => requestFrame(id, d, params as Static<P>),
    encodeResponse: (id, result) => responseFrame(id, { result }),
    ...(def.capabilities !== undefined
      ? { capabilities: def.capabilities }
      : {}),
  };
  return d as RpcDefinition<Name, P, R> & {
    readonly capabilities: Caps;
  };
}

export interface NotificationDefinition<
  Name extends string,
  P extends TSchema,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly validateParams: (data: unknown) => data is Static<P>;
  readonly encode: (params: unknown) => NotificationFrame;
}

/** Type-only accessor for a notification's params payload. */
export type NotificationParamsOf<
  D extends NotificationDefinition<string, TSchema>,
> = D extends NotificationDefinition<string, infer P> ? Static<P> : never;

export function defineNotification<
  Name extends string,
  P extends TSchema,
>(def: { name: Name; params: P }): NotificationDefinition<Name, P> {
  const d: NotificationDefinition<Name, P> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    validateParams: ajv.compile(def.params),
    encode: (params) => notificationFrame(d, params as Static<P>),
  };
  return d;
}

// ── Per-handler decoders (Effect-shape) ──────────────────────────────

export class RpcParamsDecodeError extends Data.TaggedError(
  "RpcParamsDecodeError",
)<{
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
  readonly data: unknown;
}> {}

export class RpcResultDecodeError extends Data.TaggedError(
  "RpcResultDecodeError",
)<{
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
  readonly data: unknown;
}> {}

export function decodeRpcParams<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  data: unknown,
): Effect.Effect<Static<P>, RpcParamsDecodeError> {
  return definition.validateParams(data)
    ? Effect.succeed(data)
    : Effect.fail(new RpcParamsDecodeError({ definition, data }));
}

export function decodeRpcResult<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  data: unknown,
): Effect.Effect<Static<R>, RpcResultDecodeError> {
  return definition.validateResult(data)
    ? Effect.succeed(data)
    : Effect.fail(new RpcResultDecodeError({ definition, data }));
}
