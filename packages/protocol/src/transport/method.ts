/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect, Schema } from "effect";
import { Rpc, type RpcMiddleware } from "@effect/rpc";
import { closedStructGuard } from "./strict-decode.js";
import type { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";

/**
 * Internal factory for descriptor construction (`defineRpc`,
 * `defineNotification`). Callers pass plain strings to descriptors, and the
 * literal type is preserved in every method/key position.
 */
export const jsonRpcMethod = <const Name extends string>(method: Name): Name =>
  method;

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
 * The structural shape of one `requires` entry: the requirement IS the
 * `@effect/rpc` middleware tag. The descriptor factory reads its `failure`
 * schema for wire-error aggregation and treats the tag itself as the authority
 * marker the engine stacks.
 */
export type RequirementShape = RpcMiddleware.TagClassAny & {
  readonly failure: Schema.Schema.AnyNoContext;
};

type RpcMemberPayload<P extends Schema.Schema.AnyNoContext> =
  P extends Schema.Struct.Fields ? Schema.Struct<P> : P;

/**
 * Typed manifest for one RPC method: wire name + Effect `Schema` shapes +
 * decode-time validators + the `requires` authority list. Type-only payload
 * accessors are exposed via `ParamsOf&lt;D>`/`ResultOf&lt;D>` — there is no
 * runtime `Params`/`Result` property.
 *
 * The `paramsSchema`/`resultSchema` are Effect `Schema` values (`P`/`R extends
 * Schema.Schema.AnyNoContext` — the wire schemas have no decode context).
 * `validateParams`/`validateResult` are strict, excess-rejecting type guards
 * (`closedStructGuard`): a bare `Schema.is` would ACCEPT extra keys, so the
 * guards wrap a `Schema.decodeUnknownEither(schema)(value, { onExcessProperty:
 * "error" })` to reject excess properties at the trust boundary.
 *
 * `requires` is the one authority axis: the client groups partition on its head
 * (the principal requirement), the server stacks each requirement middleware,
 * and the descriptor folds each requirement's `failure` into the effective wire
 * error union.
 */
export interface RpcDefinition<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  Requires extends
    ReadonlyArray<RequirementShape> = ReadonlyArray<RequirementShape>,
  Errs extends ReadonlyArray<RpcErrorClass> = ReadonlyArray<RpcErrorClass>,
> {
  readonly name: Name;
  readonly paramsSchema: P;
  readonly resultSchema: R;
  readonly clientRpc: Rpc.Rpc<
    Name,
    RpcMemberPayload<P>,
    R,
    Schema.Schema.AnyNoContext
  >;
  readonly serverRpc: Rpc.Rpc<
    Name,
    RpcMemberPayload<P>,
    R,
    Schema.Schema.AnyNoContext,
    Requires[number]
  >;

  /**
   * The ordered authority list. The FIRST element is exactly one principal
   * requirement (`AgentPrincipal` | `AppPrincipal` |
   * `AuthenticatedPrincipal`); an optional `AgentClaimed` refinement
   * (agent-only) follows; the rest are capability tags, in run order. Empty for
   * the unauthenticated connect methods (`agent/connect`, `app/connect`). The
   * server stacks each requirement middleware; each element's `failure` folds
   * into the wire error union.
   */
  readonly requires: Requires;

  /**
   * The handler-domain tagged-error classes this method can fail with — only
   * the errors the HANDLER raises, not the requirement (principal/cap) errors
   * (those come from each requirement's own `failure`). The method's effective
   * wire error union is the union of both; see
   * {@link effectiveErrorClasses} / {@link errorSchema}.
   */
  readonly errors: Errs;

  /**
   * The wire `error` Schema the `@effect/rpc` engine encodes/decodes this
   * method's failures against: `Schema.Union(...effectiveErrorClasses)`. The
   * union discriminates on each error's `_tag`, so the per-method decode picks
   * the exact tagged-error class with no code lookup and no global registry.
   * `Schema.Never` when the method has no effective errors. Connect methods
   * still inherit transport errors at the client surface via
   * {@link ResponseErrorsOf}.
   */
  readonly errorSchema: Schema.Schema.AnyNoContext;

  /**
   * The wire `error` Schema for the HANDLER-DOMAIN errors ALONE
   * (`Schema.Union(...errors)`) — what the server engine member sets as its
   * `error`. The principal-gate and cap errors are NOT here; they ride each
   * stacked middleware's own `failure`, and the engine unions them into the
   * method's error (`Rpc.ErrorSchema = _Error | _Middleware`). The catalog/client
   * group uses the full {@link errorSchema} (the client carries no middleware,
   * so it needs the aggregate union for its typed error channel).
   */
  readonly handlerErrorSchema: Schema.Schema.AnyNoContext;

  readonly validateParams: (data: unknown) => data is Schema.Schema.Type<P>;
  readonly validateResult: (data: unknown) => data is Schema.Schema.Type<R>;
}

export type RpcDefinitionAny = RpcDefinition<any, any, any, any, any>;

/** Type-only accessor for a definition's params payload. */
export type ParamsOf<D extends RpcDefinitionAny> = Schema.Schema.Type<
  D["paramsSchema"]
>;

/** Type-only accessor for a definition's result payload. */
export type ResultOf<D extends RpcDefinitionAny> = Schema.Schema.Type<
  D["resultSchema"]
>;

/**
 * The transport-level errors any descriptor-driven call can surface regardless
 * of the method: the socket was not connected, or the response frame never
 * arrived. They originate at the client transport, not the handler, so they are
 * NOT in a descriptor's effective error union; the typed client adds them to
 * every per-method call's error channel.
 */
export type ResponseErrorsOf = NotConnectedError | RpcTimeoutError;

/**
 * The union of every requirement middleware's failure type for a `requires`
 * tuple. Empty `requires` yields `never`.
 */
export type RequirementErrorsOf<
  Requires extends ReadonlyArray<RequirementShape>,
> =
  Requires[number] extends RpcMiddleware.TagClass<any, string, infer Options>
    ? RpcMiddleware.TagClass.Failure<Options>
    : never;

/**
 * The handler-domain error instance union a descriptor declares.
 */
export type DomainErrorsOf<D extends RpcDefinitionAny> =
  D extends RpcDefinition<any, any, any, any, infer Errs>
    ? InstanceType<Errs[number]>
    : never;

/**
 * The full typed error channel of a per-method call: the method's handler-domain
 * errors, every requirement's declared errors, plus the always-possible
 * transport errors. This is exactly what the typed client surfaces on
 * `client["method/name"](payload)`'s Effect — the same union the wire
 * `errorSchema` decodes, plus transport.
 */
export type CallErrorsOf<D extends RpcDefinitionAny> =
  D extends RpcDefinition<any, any, any, infer Requires, any>
    ? DomainErrorsOf<D> | RequirementErrorsOf<Requires> | ResponseErrorsOf
    : never;

/**
 * The effective wire-error schema list for a method: every requirement
 * middleware's failure schema (in `requires` order) then the handler-domain
 * errors. This is the single source the wire `errorSchema`, the server gate,
 * and the typed client all read.
 */
export function effectiveErrorClasses(
  requires: ReadonlyArray<RequirementShape>,
  handlerErrors: ReadonlyArray<RpcErrorClass>,
): ReadonlyArray<Schema.Schema.AnyNoContext> {
  return [
    ...requires.map((requirement) => requirement.failure),
    ...handlerErrors,
  ];
}

/**
 * The wire `error` Schema for a method's effective error classes: a `_tag`-
 * discriminated `Schema.Union` the engine decodes against. `Schema.Never` when
 * the list is empty; transport failures are added at the client surface.
 */
function makeErrorSchema(
  classes: ReadonlyArray<Schema.Schema.AnyNoContext>,
): Schema.Schema.AnyNoContext {
  // `Schema.Union` over the effective error classes — discriminated by `_tag`.
  // The zero-arg union is the empty (never) error arm for a method that raises
  // no typed wire error; the one-arg
  // union is that single error. One construction path keeps the variance
  // uniform (`Schema.Never`'s narrow `annotations` signature is not assignable
  // to the descriptor's `Schema<any, any, never>` slot).
  return Schema.Union(...classes);
}

/**
 * Create one wire method's frozen descriptor: name, Effect `Schema` shapes,
 * the effective wire error union, and strict decode-time validators. Every wire
 * boundary in moltzap is born from a single `defineRpc` call at module-load
 * time so the strict decoders are built eagerly and the runtime never
 * re-derives them.
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
 * - Every slot is REQUIRED in the handler table; omitting any key fails TS2741
 *   at the factory call.
 * - Capabilities are NOT descriptor metadata; `defineRpc` carries only the
 *   wire shape, and the server's per-method `*AuthMw` runs the caps.
 * - The param/result validators reject excess keys (`closedStructGuard`): a
 *   bare `Schema.is` accepts unknown keys, so per-method validation closes the
 *   struct to catch a caller that sends a field the descriptor never declared.
 *
 * Method names stay as literal strings so Effect RPC's generated client remains
 * a normal string-keyed dispatch map.
 *
 * Sibling: {@link defineNotification} — same pipeline minus the
 * result schema and the error union.
 */
export function defineRpc<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  requires: readonly [];
  errors: Errs;
}): RpcDefinition<Name, P, R, readonly [], Errs>;
export function defineRpc<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const A extends RequirementShape,
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  requires: readonly [A];
  errors: Errs;
}): RpcDefinition<Name, P, R, readonly [A], Errs>;
export function defineRpc<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const A extends RequirementShape,
  const B extends RequirementShape,
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  requires: readonly [A, B];
  errors: Errs;
}): RpcDefinition<Name, P, R, readonly [A, B], Errs>;
export function defineRpc<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const A extends RequirementShape,
  const B extends RequirementShape,
  const C extends RequirementShape,
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  requires: readonly [A, B, C];
  errors: Errs;
}): RpcDefinition<Name, P, R, readonly [A, B, C], Errs>;
export function defineRpc<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const A extends RequirementShape,
  const B extends RequirementShape,
  const C extends RequirementShape,
  const D extends RequirementShape,
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;
  requires: readonly [A, B, C, D];
  errors: Errs;
}): RpcDefinition<Name, P, R, readonly [A, B, C, D], Errs>;
export function defineRpc(def: {
  name: string;
  params: Schema.Schema.AnyNoContext;
  result: Schema.Schema.AnyNoContext;

  /**
   * REQUIRED. The ordered authority list. The FIRST element is exactly one
   * principal requirement (`AgentPrincipal` | `AppPrincipal` |
   * `AuthenticatedPrincipal`); an optional `AgentClaimed` refinement
   * (agent-only) follows; the rest are capability tags, in run order. The
   * unauthenticated connect methods use `requires: []`. Each requirement folds
   * its declared `errors` into the method's effective wire error union.
   */
  requires: ReadonlyArray<RequirementShape>;

  /**
   * REQUIRED. The handler-domain tagged-error classes this method can fail
   * with — only what the handler itself raises. The principal-gate errors
   * (`Unauthorized`/`Forbidden` for authenticated methods) and each cap's own
   * `errors` are added automatically. A method with no handler-domain error
   * declares `[]`.
   */
  errors: ReadonlyArray<RpcErrorClass>;
}) {
  const name = jsonRpcMethod(def.name);
  const errorSchema = makeErrorSchema(
    effectiveErrorClasses(def.requires, def.errors),
  );
  const handlerErrorSchema = makeErrorSchema(def.errors);
  return {
    name,
    paramsSchema: def.params,
    resultSchema: def.result,
    clientRpc: Rpc.make(name, {
      payload: def.params,
      success: def.result,
      error: errorSchema,
    }),
    serverRpc: applyRequirementMiddlewares(
      Rpc.make(name, {
        payload: def.params,
        success: def.result,
        error: handlerErrorSchema,
      }),
      def.requires,
    ),
    requires: def.requires,
    errors: def.errors,
    // The per-method wire error union the engine encodes/decodes against: every
    // requirement's declared errors ∪ the handler's declared errors, deduped,
    // discriminated by `_tag`.
    errorSchema,
    // Handler-domain errors ALONE: the engine member's `error`. The requirement
    // (principal/cap) errors come from the stacked middlewares' `failure`.
    handlerErrorSchema,
    validateParams: closedStructGuard(def.params),
    validateResult: closedStructGuard(def.result),
  };
}

function applyRequirementMiddlewares(
  member: Rpc.Rpc<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
  requirements: ReadonlyArray<RequirementShape>,
) {
  let gated:
    | typeof member
    | Rpc.Rpc<
        string,
        Schema.Schema.AnyNoContext,
        Schema.Schema.AnyNoContext,
        Schema.Schema.AnyNoContext,
        RequirementShape
      > = member;
  for (let index = requirements.length - 1; index >= 0; index -= 1) {
    const requirement = requirements[index];
    if (requirement !== undefined) {
      gated = gated.middleware(requirement);
    }
  }
  return gated;
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
 *   Server->>Server: frame notification from descriptor + params
 *   Server->>Wire: {jsonrpc, method, params}
 *   Wire->>Client: frame arrives (has method → reverse RpcServer)
 *   Client->>Client: reverse engine decodes the notification descriptor
 *   Client->>Client: subscriber dispatcher routes to handler
 * ```
 *
 * Descriptor role at the transport layer: the wire `name` + params schema +
 * strict decode-time validator. Routing semantics live in consumers (e.g.
 * `@moltzap/client/runtime/subscribers.ts`).
 */
export interface NotificationDefinition<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  Params = Schema.Schema.Type<P>,
> {
  readonly name: Name;
  readonly paramsSchema: P;
  readonly notificationRpc: Rpc.Rpc<
    Name,
    RpcMemberPayload<P>,
    typeof Schema.Void,
    typeof Schema.Never
  >;
  readonly validateParams: (data: unknown) => data is Params;
}

export type NotificationDefinitionAny = NotificationDefinition<
  any,
  any,
  unknown
>;

/** Type-only accessor for a notification's outbound call payload. */
export type NotificationPayloadOf<D extends NotificationDefinitionAny> =
  Rpc.PayloadConstructor<D["notificationRpc"]>;

/** Type-only accessor for a decoded notification delivery payload. */
export type NotificationParamsOf<D extends NotificationDefinitionAny> =
  Rpc.Payload<D["notificationRpc"]>;

/**
 * Descriptor-tagged notification delivery after native Effect RPC/Schema
 * decode. This is the broad-subscription shape; typed subscriptions consume
 * `NotificationParamsOf<D>` directly.
 */
export interface NotificationDelivery<
  D extends NotificationDefinitionAny = NotificationDefinitionAny,
> {
  readonly definition: D;
  readonly method: D["name"];
  readonly params: NotificationParamsOf<D>;
}

export function isNotificationDeliveryFor<D extends NotificationDefinitionAny>(
  delivery: NotificationDelivery,
  definition: D,
): delivery is NotificationDelivery<D> {
  return (
    delivery.definition === definition &&
    definition.validateParams(delivery.params)
  );
}

/**
 * Sibling of {@link defineRpc} for server-to-client notifications.
 * Same pipeline minus the result schema — notifications are
 * fire-and-forget, no `id` field, no `result`.
 */
export function defineNotification<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
>(def: {
  name: Name;
  params: P;
}): NotificationDefinition<Name, P, Schema.Schema.Type<P>> {
  const name = jsonRpcMethod(def.name);
  return {
    name,
    paramsSchema: def.params,
    notificationRpc: Rpc.make(name, {
      payload: def.params,
      success: Schema.Void,
      error: Schema.Never,
    }),
    validateParams: closedStructGuard(def.params),
  };
}

// ── Per-handler result decoder (Effect-shape; consumed by the conformance
// test-client to verify a response decodes against the descriptor schema) ───

class RpcResultDecodeError extends Data.TaggedError("RpcResultDecodeError")<{
  readonly definition: RpcDefinitionAny;
  readonly data: unknown;
}> {}

export function decodeRpcResult<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  Requires extends ReadonlyArray<RequirementShape>,
  Errs extends ReadonlyArray<RpcErrorClass>,
>(
  definition: RpcDefinition<Name, P, R, Requires, Errs>,
  data: unknown,
): Effect.Effect<Schema.Schema.Type<R>, RpcResultDecodeError> {
  return definition.validateResult(data)
    ? Effect.succeed(data)
    : Effect.fail(new RpcResultDecodeError({ definition, data }));
}
