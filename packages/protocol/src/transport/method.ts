/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect, Schema } from "effect";
import { closedStructGuard } from "../schema-primitives.js";
import {
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

/**
 * Typed manifest for one RPC method: wire name + Effect `Schema` shapes +
 * decode-time validators. Type-only payload accessors are exposed via
 * `ParamsOf&lt;D>`/`ResultOf&lt;D>` — there is no runtime `Params`/`Result`
 * property.
 *
 * The `paramsSchema`/`resultSchema` are Effect `Schema` values (`P`/`R extends
 * Schema.Schema.AnyNoContext` — the wire schemas have no decode context).
 * `validateParams`/`validateResult` are strict, excess-rejecting type guards
 * (`closedStructGuard`) that match the former `ajv.compile(schema)` strict
 * behavior: a bare `Schema.is` would ACCEPT extra keys, so the guards wrap a
 * `Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" })`
 * to preserve AJV `strict` rejection at the trust boundary.
 *
 * #705 HALF-2 — a method's per-frame capabilities are NO LONGER descriptor
 * metadata. They are declared at the server binding site as
 * `CapabilityMiddleware` tuples woven by `defineXMiddlewareMethod`; the
 * descriptor carries only the wire shape. The former optional
 * `capabilities` field (+ its `argsOf` resolvers) and the runtime
 * `dischargeCaps` fold that read it are gone.
 */
export interface RpcDefinition<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly resultSchema: R;
  readonly validateParams: (data: unknown) => data is Schema.Schema.Type<P>;
  readonly validateResult: (data: unknown) => data is Schema.Schema.Type<R>;
  // `unknown` for variance compatibility with the
  // `<string, AnyNoContext, AnyNoContext>` supertype; concrete call sites
  // pass typed values.
  readonly encodeRequest: (id: string, params: unknown) => RequestFrame;
  readonly encodeResponse: (
    id: JsonRpcId | null,
    result: unknown,
  ) => ResponseFrame;
}

/** Type-only accessor for a definition's params payload. */
export type ParamsOf<
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
> =
  D extends RpcDefinition<string, infer P, Schema.Schema.AnyNoContext>
    ? Schema.Schema.Type<P>
    : never;

/** Type-only accessor for a definition's result payload. */
export type ResultOf<
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
> =
  D extends RpcDefinition<string, Schema.Schema.AnyNoContext, infer R>
    ? Schema.Schema.Type<R>
    : never;

/**
 * Create one wire method's frozen descriptor: name, Effect `Schema` shapes,
 * strict decode-time validators, and per-descriptor request/response
 * encoders. Every wire boundary in moltzap is born from a single `defineRpc`
 * call at module-load time so the strict decoders are built eagerly and the
 * runtime never re-derives them.
 *
 * ```mermaid
 * flowchart TD
 *   A["domain layer call site:<br>defineRpc{ name, params, result }"]
 *   A --> B["closedStructGuard(params)<br>→ validateParams (strict decode)"]
 *   A --> C["closedStructGuard(result)<br>→ validateResult (strict decode)"]
 *   B --> D["RpcDefinition&lt;Name, P, R&gt;"]
 *   C --> D
 *   D --> E["pushed into per-layer *RpcMethods const"]
 *   E --> F["aggregated into rpcMethods"]
 * ```
 *
 * - Every slot is REQUIRED in the handler table (Spec D3 R14b);
 *   omitting any key fails TS2741 at the factory call.
 * - #705 HALF-2: capabilities are NOT descriptor metadata. They are
 *   declared at the server binding site as `CapabilityMiddleware` tuples;
 *   `defineRpc` carries only the wire shape.
 * - The validators reject excess keys (`closedStructGuard`), preserving the
 *   AJV `strict` + `additionalProperties:false` rejection the conformance
 *   suite's `extra-property` / `oversized` mutators assert.
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
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(def: { name: Name; params: P; result: R }): RpcDefinition<Name, P, R> {
  const d: RpcDefinition<Name, P, R> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    resultSchema: def.result,
    validateParams: closedStructGuard(def.params),
    validateResult: closedStructGuard(def.result),
    // `params` is `unknown` ONLY because the descriptor's `encodeRequest`
    // signature is the variance-erased supertype shape; the caller passes an
    // already-typed `Schema.Schema.Type<P>`. This is an ENCODE-side
    // re-widening of a trusted local value, not a decode of untrusted wire
    // input, so it does not go through `Schema.decode*` (which is what the
    // no-schema-type-cast rule guards against at trust boundaries).
    encodeRequest: (id, params) =>
      // eslint-disable-next-line agent-code-guard/no-schema-type-cast -- encode-side re-widen of trusted typed params, not a wire decode
      requestFrame(id, d, params as Schema.Schema.Type<P>),
    encodeResponse: (id, result) => responseFrame(id, { result }),
  };
  return d;
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
  P extends Schema.Schema.AnyNoContext,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly validateParams: (data: unknown) => data is Schema.Schema.Type<P>;
  readonly encode: (params: unknown) => NotificationFrame;
}

/** Type-only accessor for a notification's params payload. */
export type NotificationParamsOf<
  D extends NotificationDefinition<string, Schema.Schema.AnyNoContext>,
> =
  D extends NotificationDefinition<string, infer P>
    ? Schema.Schema.Type<P>
    : never;

/**
 * Sibling of {@link defineRpc} for server-to-client notifications.
 * Same pipeline minus the result schema and response encoder —
 * notifications are fire-and-forget, no `id` field, no `result`.
 */
export function defineNotification<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
>(def: { name: Name; params: P }): NotificationDefinition<Name, P> {
  const d: NotificationDefinition<Name, P> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    validateParams: closedStructGuard(def.params),
    // Encode-side re-widen of trusted typed params (see `defineRpc`'s
    // `encodeRequest` note); not a wire decode.
    // eslint-disable-next-line agent-code-guard/no-schema-type-cast -- encode-side re-widen of trusted typed params, not a wire decode
    encode: (params) => notificationFrame(d, params as Schema.Schema.Type<P>),
  };
  return d;
}

// ── Per-handler decoders (Effect-shape) ──────────────────────────────

export class RpcParamsDecodeError extends Data.TaggedError(
  "RpcParamsDecodeError",
)<{
  readonly definition: RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >;
  readonly data: unknown;
}> {}

export class RpcResultDecodeError extends Data.TaggedError(
  "RpcResultDecodeError",
)<{
  readonly definition: RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >;
  readonly data: unknown;
}> {}

export function decodeRpcParams<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(
  definition: RpcDefinition<Name, P, R>,
  data: unknown,
): Effect.Effect<Schema.Schema.Type<P>, RpcParamsDecodeError> {
  return definition.validateParams(data)
    ? Effect.succeed(data)
    : Effect.fail(new RpcParamsDecodeError({ definition, data }));
}

export function decodeRpcResult<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(
  definition: RpcDefinition<Name, P, R>,
  data: unknown,
): Effect.Effect<Schema.Schema.Type<R>, RpcResultDecodeError> {
  return definition.validateResult(data)
    ? Effect.succeed(data)
    : Effect.fail(new RpcResultDecodeError({ definition, data }));
}
