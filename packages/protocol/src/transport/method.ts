/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect, Schema, type Context } from "effect";
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
 * The calling-principal axis of one RPC: which principal arm may originate it.
 * `"agent"`/`"app"` gate the method to that arm; `"any"` is the lone
 * unauthenticated method (`network/connect`, dispatched while the arm is still
 * unauthenticated). This is the single descriptor-level source the client
 * groups partition on and the server's principal gate reads.
 */
export type CallablePrincipal = "agent" | "app" | "any";

/**
 * A capability tag a method requires: the `Context.Tag` the per-method
 * `AuthMiddleware` provides as a field of the method's `AuthContext` proof. The
 * cap's runtime derive/obtain lives server-side; the descriptor names only WHICH
 * caps the method requires and in what order. `Context.Tag<any, any>` is the
 * variance-agnostic carrier (a concrete class tag is not assignable to
 * `Context.Tag<unknown, unknown>`), matching `capability-middleware.ts`'s
 * `AnyContextTag`.
 */
export type RpcCapTag = Context.Tag<any, any>;

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
  K extends CallablePrincipal = CallablePrincipal,
  Caps extends ReadonlyArray<RpcCapTag> = ReadonlyArray<RpcCapTag>,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly resultSchema: R;

  /**
   * The calling-principal axis (the single descriptor-level source). The client
   * groups partition on it; the server principal gate reads it. Defaults to
   * `"any"` for descriptors that do not declare it (only `network/connect`
   * stays `"any"` at the gate, but an undeclared descriptor is never
   * engine-gated).
   */
  readonly callablePrincipal: K;

  /**
   * Whether the agent arm must be claimed/active to call this method
   * (agent-arm only). Read by the server gate; ignored for `"app"`/`"any"`.
   */
  readonly requiresActive: boolean;

  /**
   * The capability tags this method requires, in run order. The per-method
   * `AuthMiddleware` runs each cap's derive/obtain (server-side) after
   * resolving the principal, then provides the combined proof. Empty for a
   * method with no caps.
   */
  readonly caps: Caps;

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
  const K extends CallablePrincipal = "any",
  const Caps extends ReadonlyArray<RpcCapTag> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  callablePrincipal?: K;
  requiresActive?: boolean;
  caps?: Caps;
}): RpcDefinition<Name, P, R, K, Caps> {
  const d: RpcDefinition<Name, P, R, K, Caps> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    resultSchema: def.result,
    // §F.3a auth axis — the single descriptor-level source. Defaults keep
    // existing `defineRpc` call sites compiling unchanged: an undeclared
    // method is `"any"`/no-caps, populated per-method as the server cutover
    // reads them. `K extends "any"`'s default + the `?? "any"` runtime default
    // agree, so the type and the value match.
    callablePrincipal: def.callablePrincipal ?? ("any" as K),
    requiresActive: def.requiresActive ?? false,
    // When `def.caps` is omitted, `Caps` infers to its default `readonly []`,
    // for which the empty tuple is the sound value; the no-arg branch only
    // reaches the default when `Caps` is exactly that, so the assertion is the
    // generic-default laundering TS cannot express on the union of the two arms.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- generic-default laundering: the `?? []` branch is reached only when `def.caps` is omitted, where `Caps` infers to `readonly []` and `[]` is its sound value.
    caps: def.caps ?? ([] as unknown as Caps), // #ignore-sloppy-code[as-unknown-as]: generic-default laundering, the empty tuple is the sound value of the inferred `readonly []` default.
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

// ── Per-handler result decoder (Effect-shape; consumed by the conformance
// test-client to verify a response decodes against the descriptor schema) ───

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
