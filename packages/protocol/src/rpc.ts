import { type TSchema, type Static } from "@sinclair/typebox";
import { Data, Effect } from "effect";
import { ajv } from "./internal/ajv.js";
import { jsonRpcMethod, type JsonRpcMethod } from "./schema/json-rpc.js";

/**
 * Re-export TypeBox type helpers so downstream packages (client, server)
 * can type against manifests without taking a direct typebox dependency.
 */
export type { TSchema, Static } from "@sinclair/typebox";

/**
 * A typed manifest for one RPC method. Couples:
 *   - `name` — the wire-level method string (e.g. `"agents/lookupByName"`)
 *   - `paramsSchema` / `resultSchema` — TypeBox schemas (runtime values)
 *   - `validateParams` / `validateResult` — pre-compiled AJV validators
 *   - `Params` / `Result` — phantom type carriers so call sites can write
 *     `Static<D["paramsSchema"]>` without paying a generic-inference cost
 *
 * The `Name` type parameter is preserved as a literal string so
 * `rpcMethods[number]["name"]` produces a union of every wire method.
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
  /** Phantom carrier — inspect with `typeof def.Params` to get `Static<P>`. */
  readonly Params: Static<P>;
  /** Phantom carrier — inspect with `typeof def.Result` to get `Static<R>`. */
  readonly Result: Static<R>;
}

/**
 * Build an `RpcDefinition` from a TypeBox params + result schema. Compiles
 * the validators at descriptor construction time so every transport boundary
 * validates both inbound params and outbound results with the same schema.
 */
export function defineRpc<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(def: { name: Name; params: P; result: R }): RpcDefinition<Name, P, R> {
  return {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    resultSchema: def.result,
    validateParams: ajv.compile(def.params),
    validateResult: ajv.compile(def.result),
    // Phantom — never read at runtime. Typed as `Static<P>` so
    // `typeof def.Params` at the type level yields the params type.
    Params: null!,
    Result: null!,
  };
}

/** Extract the params type from an RpcDefinition. */
export type ParamsOf<D> =
  D extends RpcDefinition<string, infer P, TSchema> ? Static<P> : never;

/** Extract the result type from an RpcDefinition. */
export type ResultOf<D> =
  D extends RpcDefinition<string, TSchema, infer R> ? Static<R> : never;

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
  D extends RpcDefinition<string, TSchema, TSchema>,
>(
  definition: D,
  data: unknown,
): Effect.Effect<ParamsOf<D>, RpcParamsDecodeError>;
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
  D extends RpcDefinition<string, TSchema, TSchema>,
>(
  definition: D,
  data: unknown,
): Effect.Effect<ResultOf<D>, RpcResultDecodeError>;
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
