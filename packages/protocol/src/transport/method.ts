/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect, Schema, type Context } from "effect";
import { closedStructGuard } from "../schema-primitives.js";
import type { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";
import { principalGateErrorClasses } from "./wire-errors.js";
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
 * A wire-discriminable tagged-error CLASS: a `Schema.TaggedError`-derived class
 * usable both as the runtime constructor and as a `Schema` for the wire `error`
 * union. The `_tag` literal is the union discriminant the engine decodes against;
 * a method's `error` Schema is `Schema.Union(...effective error classes)`, so the
 * per-method decode picks the right class by `_tag` with no code lookup.
 */
export type RpcErrorClass = Schema.Schema.AnyNoContext &
  (new (...args: never[]) => { readonly _tag: string });

/**
 * A capability tag a method requires: a `Context.Tag` (the proof the per-method
 * middleware provides). A capability IS a middleware — it resolves a proof into
 * context and declares its own `errors` (the tagged-error classes its
 * derive/obtain can fail with) as a static tuple on the tag class. The
 * descriptor unions every cap's `errors` into the method's effective error
 * channel ({@link CapErrorsOf}), so a method that requires a cap inherits that
 * cap's failure modes with no re-declaration.
 *
 * The type is the plain `Context.Tag<any, any>` (not intersected with an
 * `errors` member): a concrete tag class does not match an intersection whose
 * other arm is the variance-laden Tag, so the `errors` static is read
 * structurally by {@link CapErrorClassesOf} rather than constrained here.
 */
export type RpcCapTag = Context.Tag<any, any>;

/**
 * The error class tuple a cap tag declares as its static `errors`, or `[]` when
 * the cap declares none. Read structurally off the tag class so `RpcCapTag` can
 * stay the plain Tag type.
 */
export type CapErrorClassesOf<C> = C extends {
  readonly errors: infer E extends ReadonlyArray<RpcErrorClass>;
}
  ? E
  : readonly [];

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
 * A method's per-frame capabilities are NOT descriptor metadata: the
 * descriptor carries only the wire shape. The server's per-method `*AuthMw`
 * impl Layer runs each declared cap's derive/obtain
 * (`server-core auth-middleware-layers.ts`).
 */
export interface RpcDefinition<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  K extends CallablePrincipal = CallablePrincipal,
  Caps extends ReadonlyArray<RpcCapTag> = ReadonlyArray<RpcCapTag>,
  Errs extends ReadonlyArray<RpcErrorClass> = ReadonlyArray<RpcErrorClass>,
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
   * The capability tags this method requires, in run order. Each cap IS a
   * middleware: it provides a proof into the handler's Context and declares its
   * own `errors`. The per-method middleware runs each cap's derive/obtain after
   * resolving the principal. Empty for a method with no caps.
   */
  readonly caps: Caps;

  /**
   * The handler-domain tagged-error classes this method can fail with — only
   * the errors the HANDLER raises, not the principal-gate or cap errors (those
   * come from {@link principalErrorClasses} and each cap's own `errors`). The
   * method's effective wire error union is the dedup'd union of all three; see
   * {@link effectiveErrorClasses} / {@link errorSchema}.
   */
  readonly errors: Errs;

  /**
   * The wire `error` Schema the `@effect/rpc` engine encodes/decodes this
   * method's failures against: `Schema.Union(...effectiveErrorClasses)`. The
   * union discriminates on each error's `_tag`, so the per-method decode picks
   * the exact tagged-error class with no code lookup and no global registry.
   * `Schema.Never` when the method has no effective errors (only the lone
   * unauthenticated `network/connect`, which still inherits transport errors at
   * the client surface via {@link ResponseErrorsOf}).
   */
  readonly errorSchema: Schema.Schema.AnyNoContext;

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
 * The transport-level errors any descriptor-driven call can surface regardless
 * of the method: the socket was not connected, or the response frame never
 * arrived. They originate at the client transport, not the handler, so they are
 * NOT in a descriptor's effective error union; the typed client adds them to
 * every per-method call's error channel.
 */
export type ResponseErrorsOf = NotConnectedError | RpcTimeoutError;

/**
 * The principal-gate tagged-error classes a method's `callablePrincipal` admits.
 * Every authenticated method's principal middleware can fail
 * `Unauthorized`/`Forbidden`; the lone `"any"` method (`network/connect`) has no
 * principal gate, so it admits none. Sourced as a value at
 * {@link principalErrorClasses}; this is its type-level mirror.
 */
export type PrincipalErrorClassesOf<K extends CallablePrincipal> =
  K extends "any" ? readonly [] : typeof principalGateErrorClasses;

/**
 * The union of error instance types a single cap tag declares (its static
 * `errors` tuple's instance union), read structurally.
 */
type CapErrorInstances<C> = InstanceType<CapErrorClassesOf<C>[number]>;

/**
 * The union of every declared cap's error instances for a `caps` tuple.
 */
export type CapErrorsOf<Caps extends ReadonlyArray<RpcCapTag>> =
  CapErrorInstances<Caps[number]>;

/**
 * The handler-domain error instance union a descriptor declares.
 */
export type DomainErrorsOf<
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
> =
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    CallablePrincipal,
    ReadonlyArray<RpcCapTag>,
    infer Errs
  >
    ? InstanceType<Errs[number]>
    : never;

/**
 * The full typed error channel of a per-method call: the method's handler-domain
 * errors, its caps' declared errors, its principal-gate errors, plus the
 * always-possible transport errors. This is exactly what the typed client
 * surfaces on `client["method/name"](payload)`'s Effect — the same union the
 * wire `errorSchema` decodes, plus transport.
 */
export type CallErrorsOf<
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
> =
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    infer K,
    infer Caps,
    ReadonlyArray<RpcErrorClass>
  >
    ?
        | DomainErrorsOf<D>
        | CapErrorsOf<Caps>
        | InstanceType<PrincipalErrorClassesOf<K>[number]>
        | ResponseErrorsOf
    : never;

/**
 * The effective wire-error class list for a method: principal-gate errors (none
 * for the unauthenticated `"any"` method), each cap's declared errors in cap
 * order, then the handler-domain errors, deduped by identity (a class shared
 * across a cap and the handler list appears once). This is the single source the
 * wire `errorSchema`, the server gate, and the typed client all read.
 */
export function effectiveErrorClasses(
  callablePrincipal: CallablePrincipal,
  caps: ReadonlyArray<RpcCapTag>,
  handlerErrors: ReadonlyArray<RpcErrorClass>,
): ReadonlyArray<RpcErrorClass> {
  const principal: ReadonlyArray<RpcErrorClass> =
    callablePrincipal === "any" ? [] : principalGateErrorClasses;
  const all = [
    ...principal,
    ...caps.flatMap(capErrorClasses),
    ...handlerErrors,
  ];
  return [...new Set(all)];
}

/**
 * Read a cap tag's declared static `errors`, or `[]` when it declares none.
 * The `errors` static is not part of the `RpcCapTag` type (a concrete tag
 * class will not match an intersection with the variance-laden Tag), so it is
 * read structurally here — the runtime mirror of {@link CapErrorClassesOf}.
 */
function capErrorClasses(cap: RpcCapTag): ReadonlyArray<RpcErrorClass> {
  const errors = (cap as { readonly errors?: ReadonlyArray<RpcErrorClass> })
    .errors;
  return errors ?? [];
}

/**
 * The wire `error` Schema for a method's effective error classes: a `_tag`-
 * discriminated `Schema.Union` the engine decodes against. `Schema.Never` when
 * the list is empty (the unauthenticated `network/connect` raises no typed wire
 * error; transport failures are added at the client surface).
 */
function makeErrorSchema(
  classes: ReadonlyArray<RpcErrorClass>,
): Schema.Schema.AnyNoContext {
  // `Schema.Union` over the effective error classes — discriminated by `_tag`.
  // The zero-arg union is the empty (never) error arm for a method that raises
  // no typed wire error (the unauthenticated `network/connect`); the one-arg
  // union is that single error. One construction path keeps the variance
  // uniform (`Schema.Never`'s narrow `annotations` signature is not assignable
  // to the descriptor's `Schema<any, any, never>` slot).
  return Schema.Union(...classes);
}

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
 * - Capabilities are NOT descriptor metadata; `defineRpc` carries only the
 *   wire shape, and the server's per-method `*AuthMw` runs the caps.
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
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  callablePrincipal?: K;
  requiresActive?: boolean;
  caps?: Caps;

  /**
   * REQUIRED. The handler-domain tagged-error classes this method can fail
   * with — only what the handler itself raises. The principal-gate errors
   * (`Unauthorized`/`Forbidden` for authenticated methods) and each cap's own
   * `errors` are added automatically. A method with no handler-domain error
   * declares `[]`.
   */
  errors: Errs;
}): RpcDefinition<Name, P, R, K, Caps, Errs> {
  const callablePrincipal = def.callablePrincipal ?? ("any" as K);
  // When `def.caps` is omitted, `Caps` infers to its default `readonly []`,
  // for which the empty tuple is the sound value; the no-arg branch only
  // reaches the default when `Caps` is exactly that, so the assertion is the
  // generic-default laundering TS cannot express on the union of the two arms.
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- generic-default laundering: the `?? []` branch is reached only when `def.caps` is omitted, where `Caps` infers to `readonly []` and `[]` is its sound value.
  const caps = def.caps ?? ([] as unknown as Caps); // #ignore-sloppy-code[as-unknown-as]: generic-default laundering, the empty tuple is the sound value of the inferred `readonly []` default.
  const d: RpcDefinition<Name, P, R, K, Caps, Errs> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    resultSchema: def.result,
    // §F.3a auth axis — the single descriptor-level source. The client groups
    // partition on it; the server principal gate reads it. `"any"` is the lone
    // unauthenticated method (`network/connect`).
    callablePrincipal,
    requiresActive: def.requiresActive ?? false,
    caps,
    errors: def.errors,
    // The per-method wire error union the engine encodes/decodes against:
    // principal-gate errors (authenticated methods) ∪ each cap's declared
    // errors ∪ the handler's declared errors, deduped, discriminated by `_tag`.
    errorSchema: makeErrorSchema(
      effectiveErrorClasses(callablePrincipal, caps, def.errors),
    ),
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

/**
 * Decode a wire `error` payload (`{ _tag, message, data? }`) against a method's
 * effective error union (`definition.errorSchema`). Returns the reconstructed
 * domain tagged-error INSTANCE — the real `TaskRejectedError` / `Forbidden` /
 * etc. — so a consumer discriminates it with `Effect.catchTag(...)` rather than
 * matching a string. Fails with `RpcResultDecodeError` when the payload's `_tag`
 * is not in the method's union (a server/method contract violation).
 */
export function decodeRpcError(
  definition: RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
  wire: unknown,
): Effect.Effect<unknown, RpcResultDecodeError> {
  return Schema.decodeUnknown(definition.errorSchema)(wire).pipe(
    Effect.mapError(() => new RpcResultDecodeError({ definition, data: wire })),
  );
}
