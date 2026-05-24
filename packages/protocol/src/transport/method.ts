/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
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

/**
 * Create one wire method's frozen descriptor: name, schemas, AJV
 * validators, and per-descriptor request/response encoders. Every
 * wire boundary in moltzap is born from a single `defineRpc` call at
 * module-load time so AJV validators are compiled eagerly and the
 * runtime never re-parses schemas.
 *
 * ```mermaid
 * flowchart TD
 *   A["domain layer call site:<br>defineRpc{ name, params, result, optional?, capabilities? }"]
 *   A --> B["ajv.compile(params)<br>→ validateParams"]
 *   A --> C["ajv.compile(result)<br>→ validateResult"]
 *   B --> D["RpcDefinition&lt;Name, P, R&gt;"]
 *   C --> D
 *   D --> E["pushed into per-layer *RpcMethods const"]
 *   E --> F["aggregated into rpcMethods"]
 * ```
 *
 * - `optional` absent → REQUIRED slot in the handler table; missing
 *   key fails compilation with TS2741 at the factory call.
 * - `optional` present → OPTIONAL slot carrying the fail-CLOSED
 *   default the dispatcher synthesizes when the slot value equals
 *   the sentinel.
 * - `capabilities` absent → no auto-provision; the dispatcher reads
 *   `definition.capabilities` per frame and threads
 *   `Effect.provideServiceEffect` for each entry.
 *
 * Method names are branded `JsonRpcMethod&lt;"the.name">` so a runtime
 * string can never accidentally type-fit a method position. See
 * `wire.ts → JsonRpcMethod` for the brand.
 *
 * Sibling: {@link defineNotification} — same pipeline minus the
 * result schema and response encoder.
 */
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

/**
 * A frozen descriptor for one server-to-client notification.
 * Notifications are fire-and-forget — no `id`, no response, no
 * pending-call registry. The transport-side runtimes don't track
 * them; consumers subscribe externally via per-method handlers.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Server
 *   participant Wire as WebSocket
 *   participant Client
 *   Server->>Server: NotificationDefinition.encode(params)
 *   Server->>Wire: {jsonrpc, method, params}
 *   Wire->>Client: frame arrives
 *   Client->>Client: decodeServerInbound<br>→ tag Notification, definition, params
 *   Client->>Client: subscriber dispatcher routes to handler
 * ```
 *
 * Descriptor role at the transport layer: encode + decode + schema
 * validation. Routing semantics live in consumers (e.g.
 * `@moltzap/client/runtime/subscribers.ts`).
 */
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

/**
 * Sibling of {@link defineRpc} for server-to-client notifications.
 * Same pipeline minus the result schema and response encoder —
 * notifications are fire-and-forget, no `id` field, no `result`.
 */
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
