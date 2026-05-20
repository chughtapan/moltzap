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
import type { FailClosedDefault } from "./defaults.js";

/**
 * Typed manifest for one RPC method: wire name + schemas + validators.
 * Type-only payload accessors are exposed via `ParamsOf&lt;D>`/`ResultOf&lt;D>`
 * — there is no runtime `Params`/`Result` property.
 *
 * Two OPTIONAL per-definition metadata fields shape dispatcher behavior:
 *
 * - `optional`: when present, the slot is OPTIONAL — every
 *   `makeServerConnection({ handlers })` literal MUST still name the
 *   slot key, but its value may be the sentinel (`forbidden` /
 *   `noOpNotification`) and the dispatcher synthesizes the fail-CLOSED
 *   response without invoking a handler. Absent → REQUIRED slot
 *   (omission is a `tsc` error at the factory call).
 * - `capabilities`: a runtime-readable list of capability descriptors
 *   the dispatcher iterates to thread `Effect.provideServiceEffect`.
 *   Each descriptor names a `Context.Tag` plus an `argsOf` resolver
 *   that derives the obtain helper's args from `params` + `ctx`.
 *   Absent → no capabilities.
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
   * Slot disposition. Absent → REQUIRED. Present → OPTIONAL with the
   * embedded fail-CLOSED default. Read by `IsOptionalSlot&lt;D>`
   * (type-level) and the runtime dispatcher.
   */
  readonly optional?: FailClosedDefault;

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
  Opt extends FailClosedDefault | undefined = undefined,
  Caps extends ReadonlyArray<CapabilityDescriptor> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;

  /**
   * Present → OPTIONAL slot with the carried fail-CLOSED default.
   * Absent → REQUIRED slot (handler-table type rejects missing key
   * with TS2741 at the factory call). See `defaults.ts → forbiddenDefault`.
   *
   * Generic-parameterized so the call-site narrows the inferred type
   * to the literal `{ optional: FailClosedDefault }` shape (vs the
   * widened `optional?: FailClosedDefault`). `IsOptionalSlot&lt;D>`
   * reads the narrowed shape; without the narrowing, every definition
   * would appear REQUIRED to the mapped-type pass.
   */
  optional?: Opt;

  /**
   * Per-definition capability descriptors. Each entry pairs a Spec E
   * `Context.Tag` (the value the handler will `yield*`) with a
   * synchronous `argsOf` resolver that derives the obtain helper's
   * arguments from wire `params` + dispatcher `ctx`. The dispatcher
   * reads this list at runtime (TypeScript erases R channels).
   *
   * Generic-parameterized so the return type preserves the literal
   * tuple shape — `CapabilitiesOf&lt;D>` reads
   * `D["capabilities"][number]["tag"]` to extract the tag union.
   * Without a captured `Caps` generic, `capabilities` widens to
   * `ReadonlyArray&lt;CapabilityDescriptor>` and the per-tag info is lost.
   */
  capabilities?: Caps;
}): RpcDefinition<Name, P, R> & {
  readonly optional: Opt;
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
    ...(def.optional !== undefined ? { optional: def.optional } : {}),
    ...(def.capabilities !== undefined
      ? { capabilities: def.capabilities }
      : {}),
  };
  return d as RpcDefinition<Name, P, R> & {
    readonly optional: Opt;
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
