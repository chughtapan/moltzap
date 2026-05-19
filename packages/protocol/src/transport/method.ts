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
import type { SlotDisposition } from "./defaults.js";

/**
 * Typed manifest for one RPC method: wire name + schemas + validators.
 * Type-only payload accessors are exposed via `ParamsOf&lt;D>`/`ResultOf&lt;D>`
 * — there is no runtime `Params`/`Result` property.
 *
 * Spec F (#617) introduces three OPTIONAL per-definition metadata fields:
 *
 * - `slotDisposition` (Spec F G4): when present, the slot is OPTIONAL in
 *   the handler-table type and the dispatcher synthesizes the
 *   fail-CLOSED default response when the slot is absent at construction.
 *   Absent → REQUIRED slot (omission is a `tsc` error at the factory call).
 * - `capabilities` (Spec F G5/G6): a runtime-readable list of capability
 *   descriptors the dispatcher iterates to thread
 *   `Effect.provideServiceEffect`. Each descriptor names a
 *   `Context.Tag` plus an `argsOf` resolver that derives the obtain
 *   helper's arguments from `params` + `ctx`. Absent → no capabilities.
 *
 * All three are optional + read-only so the addition is non-breaking for
 * legacy `defineRpc` callers that don't yet declare them.
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
   * Spec F G4: slot disposition. Absent → REQUIRED. Present → OPTIONAL
   * with the embedded fail-CLOSED default. Read by `IsOptionalSlot&lt;D>`
   * (type-level) and the runtime dispatcher.
   */
  readonly slotDisposition?: SlotDisposition;

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
  Disp extends SlotDisposition | undefined = undefined,
  Caps extends ReadonlyArray<CapabilityDescriptor> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;

  /**
   * Spec F G4: present → OPTIONAL slot with embedded fail-CLOSED default.
   * Absent → REQUIRED slot. See `defaults.ts → optionalForbidden`.
   *
   * Generic-parameterized so the call-site narrows the inferred type to
   * a literal `{ slotDisposition: SlotDisposition }` shape (vs. just
   * `slotDisposition?: SlotDisposition`). `IsOptionalSlot&lt;D&gt;` reads
   * the narrowed shape; without the narrowing, every definition would
   * appear REQUIRED to the mapped-type pass.
   */
  slotDisposition?: Disp;

  /**
   * Spec F G5/G6: capability descriptors the dispatcher iterates to
   * thread `Effect.provideServiceEffect` from a `CapabilityProviderTable`.
   * Each descriptor names a `Context.Tag` + an `argsOf` resolver.
   *
   * Generic-parameterized so the return type preserves the literal
   * tuple shape — `CapabilitiesOf&lt;D&gt;` reads
   * `D["capabilities"][number]["tag"]` to extract the tag union. Without
   * a captured `Caps` generic, `capabilities` widens to
   * `ReadonlyArray&lt;CapabilityDescriptor&gt;` and the per-tag info is
   * lost.
   */
  capabilities?: Caps;
}): RpcDefinition<Name, P, R> & {
  readonly slotDisposition: Disp;
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
    ...(def.slotDisposition !== undefined
      ? { slotDisposition: def.slotDisposition }
      : {}),
    ...(def.capabilities !== undefined
      ? { capabilities: def.capabilities }
      : {}),
  };
  return d as RpcDefinition<Name, P, R> & {
    readonly slotDisposition: Disp;
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
