import { Schema } from "effect";
import { Rpc, type RpcMiddleware } from "@effect/rpc";
import { closedStructGuard } from "./strict-decode.js";
import type { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";

/**
 * Internal factory for descriptor construction (`defineRpc`,
 * `defineNotification`). Callers pass plain strings to descriptors, and the
 * literal type is preserved in every method/key position.
 * @param method Wire method name.
 * @returns The json rpc method result.
 */
const jsonRpcMethod = <const Name extends string>(method: Name): Name => method;

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

type ErrorSchemaOf<Member extends Schema.Schema.All> = Schema.Schema<
  Schema.Schema.Type<Member>,
  Schema.Schema.Encoded<Member>,
  Schema.Schema.Context<Member>
>;

type HandlerErrorSchemaOf<Errors extends readonly RpcErrorClass[]> =
  ErrorSchemaOf<Errors[number]>;

type EffectiveErrorSchemaOf<
  Requires extends readonly RequirementShape[],
  Errors extends readonly RpcErrorClass[],
> = ErrorSchemaOf<Requires[number]["failure"] | Errors[number]>;

/**
 * Typed manifest for one RPC method: wire name + Effect `Schema` shapes +
 * decode-time validators + the `requires` authority list. Type-only payload
 * accessors are exposed via `ParamsOf&lt;D>`/`ResultOf&lt;D>`; there is no
 * runtime `Params`/`Result` property.
 *
 * The `paramsSchema`/`resultSchema` are Effect `Schema` values (`P`/`R extends
 * Schema.Schema.AnyNoContext`; the wire schemas have no decode context).
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
  Requires extends readonly RequirementShape[] = readonly RequirementShape[],
  Errs extends readonly RpcErrorClass[] = readonly RpcErrorClass[],
> {
  readonly name: Name;
  readonly paramsSchema: P;
  readonly resultSchema: R;
  readonly clientRpc: Rpc.Rpc<
    Name,
    RpcMemberPayload<P>,
    R,
    EffectiveErrorSchemaOf<Requires, Errs>
  >;
  readonly serverRpc: Rpc.Rpc<
    Name,
    RpcMemberPayload<P>,
    R,
    HandlerErrorSchemaOf<Errs>,
    Requires[number]
  >;

  /**
   * The ordered authority list. The FIRST element is exactly one principal
   * requirement (`AuthenticatedAgent`); an optional `ActiveAgent` refinement
   * (agent-only) follows; the rest are requirement tags, in run order. Empty for
   * the one unauthenticated method, `agent/network/connect`. The
   * server stacks each requirement middleware; each element's `failure` folds
   * into the wire error union.
   */
  readonly requires: Requires;

  /**
   * The handler-domain tagged-error classes this method can fail with: only
   * the errors the HANDLER raises, not the requirement middleware errors
   * (those come from each requirement's own `failure`). The method's effective
   * wire error union is the union of both; `effectiveErrorClasses` constructs
   * the `errorSchema` below.
   */
  readonly errors: Errs;

  /**
   * The wire `error` Schema the `@effect/rpc` engine encodes/decodes this
   * method's failures against: `Schema.Union(...effectiveErrorClasses)`. The
   * union discriminates on each error's `_tag`, so the per-method decode picks
   * the exact tagged-error class with no code lookup and no global registry.
   * `Schema.Never` when the method has no effective errors. The connect method
   * still inherits transport errors at the client surface via
   * {@link ResponseErrorsOf}.
   */
  readonly errorSchema: EffectiveErrorSchemaOf<Requires, Errs>;

  /**
   * The wire `error` Schema for the HANDLER-DOMAIN errors ALONE
   * (`Schema.Union(...errors)`), which the server engine member sets as its
   * `error`. The principal-gate and domain requirement errors are NOT here; they ride each
   * stacked middleware's own `failure`, and the engine unions them into the
   * method's error (`Rpc.ErrorSchema = _Error | _Middleware`). The catalog/client
   * group uses the full {@link errorSchema} (the client carries no middleware,
   * so it needs the aggregate union for its typed error channel).
   */
  readonly handlerErrorSchema: HandlerErrorSchemaOf<Errs>;

  readonly validateParams: (data: unknown) => data is Schema.Schema.Type<P>;
  readonly validateResult: (data: unknown) => data is Schema.Schema.Type<R>;
}

/**
 * Variance-safe structural surface shared by every RPC definition.
 *
 * `Rpc.Rpc` is invariant in its tag and schemas, so instantiating
 * `RpcDefinition` with broad generic arguments is not a valid existential
 * definition type. This surface retains the fields consumers need while
 * representing the RPC members through Effect's own existential `Rpc.Any`.
 */
export interface RpcDefinitionAny {
  readonly name: string;
  readonly paramsSchema: Schema.Schema.AnyNoContext;
  readonly resultSchema: Schema.Schema.AnyNoContext;
  readonly clientRpc: Rpc.Any;
  readonly serverRpc: Rpc.Any;
  readonly requires: readonly RequirementShape[];
  readonly errors: readonly RpcErrorClass[];
  readonly errorSchema: Schema.Schema.All;
  readonly handlerErrorSchema: Schema.Schema.All;
  readonly validateParams: (data: unknown) => boolean;
  readonly validateResult: (data: unknown) => boolean;
}

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
export type RequirementErrorsOf<Requires extends readonly RequirementShape[]> =
  Requires[number] extends RpcMiddleware.TagClass<
    unknown,
    string,
    infer Options
  >
    ? RpcMiddleware.TagClass.Failure<Options>
    : never;

/**
 * The handler-domain error instance union a descriptor declares.
 */
export type DomainErrorsOf<D extends RpcDefinitionAny> = InstanceType<
  D["errors"][number]
>;

/**
 * The full typed error channel of a per-method call: the method's handler-domain
 * errors, every requirement's declared errors, plus the always-possible
 * transport errors. This is exactly what the typed client surfaces on
 * `client["method/name"](payload)`'s Effect: the same union the wire
 * `errorSchema` decodes, plus transport.
 */
export type CallErrorsOf<D extends RpcDefinitionAny> =
  | DomainErrorsOf<D>
  | RequirementErrorsOf<D["requires"]>
  | ResponseErrorsOf;

/**
 * The effective wire-error schema list for a method: every requirement
 * middleware's failure schema (in `requires` order) then the handler-domain
 * errors. This is the single source the wire `errorSchema`, the server gate,
 * and the typed client all read.
 * @param requires Ordered requirement middleware declarations.
 * @param handlerErrors Handler error classes to aggregate.
 * @returns The effective error classes result.
 */
function effectiveErrorClasses<
  const Requires extends readonly RequirementShape[],
  const Errors extends readonly RpcErrorClass[],
>(
  requires: Requires,
  handlerErrors: Errors,
): ReadonlyArray<Requires[number]["failure"] | Errors[number]> {
  return [
    ...requires.map((requirement) => requirement.failure),
    ...handlerErrors,
  ];
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
 *   A["domain layer call site:; defineRpc{ name, params, result }"]
 *   A --> B["closedStructGuard(params); to validateParams (strict decode)"]
 *   A --> C["closedStructGuard(result); to validateResult (strict decode)"]
 *   B --> D["RpcDefinition&lt;Name, P, R&gt;"]
 *   C --> D
 *   D --> E["pushed into per-layer *RpcMethods const"]
 *   E --> F["aggregated into rpcMethods"]
 * ```
 *
 * - Every slot is REQUIRED in the handler table; omitting any key fails TS2741
 *   at the factory call.
 * - Requirements are descriptor metadata because they are also
 *   `@effect/rpc` middleware tags; the server supplies the implementations.
 * - The param/result validators reject excess keys (`closedStructGuard`): a
 *   bare `Schema.is` accepts unknown keys, so per-method validation closes the
 *   struct to catch a caller that sends a field the descriptor never declared.
 *
 * Method names stay as literal strings so Effect RPC's generated client remains
 * a normal string-keyed dispatch map.
 *
 * Sibling: {@link defineNotification}; same pipeline minus the
 * result schema and the error union.
 * @param def Definition to process.
 * @param def.name Wire method name.
 * @param def.params Schema for the request payload.
 * @param def.result Schema for the success payload.
 * @param def.requires Ordered requirement middleware declarations.
 * @param def.errors Handler error classes declared by the definition.
 * @returns The define rpc result.
 */
export function defineRpc<
  const Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const Requires extends readonly RequirementShape[],
  const Errs extends readonly RpcErrorClass[],
>(def: {
  name: Name;
  params: P;
  result: R;

  /**
   * REQUIRED. The ordered authority list. The FIRST element is exactly one
   * principal requirement (`AuthenticatedAgent`); an optional `ActiveAgent` refinement
   * (agent-only) follows; the rest are requirement tags, in run order. The
   * one unauthenticated method, `agent/network/connect`, uses `requires: []`.
   * Each requirement folds its declared `errors` into the method's effective
   * wire error union.
   */
  requires: Requires;

  /**
   * REQUIRED. The handler-domain tagged-error classes this method can fail
   * with: only what the handler itself raises. The principal-gate errors
   * (`Unauthorized`/`Forbidden` for authenticated methods) and each
   * requirement's own `errors` are added automatically. A method with no handler-domain error
   * declares `[]`.
   */
  errors: Errs;
}): RpcDefinition<Name, P, R, Requires, Errs> {
  const name = jsonRpcMethod(def.name);
  const errorSchema = Schema.Union(
    ...effectiveErrorClasses(def.requires, def.errors),
  );
  const handlerErrorSchema = Schema.Union(...def.errors);
  const rpc = Rpc.make(name, {
    payload: def.params,
    success: def.result,
    error: handlerErrorSchema,
  });
  return {
    name,
    paramsSchema: def.params,
    resultSchema: def.result,
    clientRpc: rpc.setError(errorSchema),
    serverRpc: applyRequirementMiddlewares(rpc, def.requires),
    requires: def.requires,
    errors: def.errors,
    // The per-method wire error union the engine encodes/decodes against: every
    // requirement's declared errors plus the handler's declared errors,
    // discriminated by `_tag`.
    errorSchema,
    // Handler-domain errors ALONE: the engine member's `error`. The requirement
    // Requirement middleware errors come from the stacked middlewares' `failure`.
    handlerErrorSchema,
    validateParams: closedStructGuard(def.params),
    validateResult: closedStructGuard(def.result),
  };
}

function applyRequirementMiddlewares<
  const Name extends string,
  Payload extends Schema.Schema.Any,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
  const Requires extends readonly RequirementShape[],
>(
  member: Rpc.Rpc<Name, Payload, Success, Error>,
  requirements: Requires,
): Rpc.Rpc<Name, Payload, Success, Error, Requires[number]> {
  let gated: Rpc.Rpc<Name, Payload, Success, Error, Requires[number]> = member;
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
 * Notifications are fire-and-forget: no `id`, no response, no
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
 *   Wire->>Client: frame arrives (has method, reverse RpcServer)
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
  readonly notificationRpc: Rpc.Rpc<Name, RpcMemberPayload<P>>;
  readonly validateParams: (data: unknown) => data is Params;
}

/**
 * Variance-safe structural surface shared by every notification definition.
 */
export interface NotificationDefinitionAny {
  readonly name: string;
  readonly paramsSchema: Schema.Schema.AnyNoContext;
  readonly notificationRpc: Rpc.Any;
  readonly validateParams: (data: unknown) => boolean;
}

/** Type-only accessor for a notification's outbound call payload. */
export type NotificationPayloadOf<D extends NotificationDefinitionAny> =
  Rpc.PayloadConstructor<D["notificationRpc"]>;

/** Type-only accessor for a decoded notification delivery payload. */
export type NotificationParamsOf<D extends NotificationDefinitionAny> =
  Rpc.Payload<D["notificationRpc"]>;

/**
 * Descriptor-tagged notification delivery after native Effect RPC/Schema
 * decode. This is the broad-subscription shape; typed subscriptions consume
 * the definition-specific params directly.
 */
export interface NotificationDelivery<
  D extends NotificationDefinitionAny = NotificationDefinitionAny,
> {
  readonly definition: D;
  readonly method: D["name"];
  readonly params: NotificationParamsOf<D>;
}

/**
 * Checks whether notification delivery for.
 * @param delivery Value supplied to the operation.
 * @param definition Protocol definition to process.
 * @returns Whether notification delivery for.
 */
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
 * Same pipeline minus the result schema; notifications are
 * fire-and-forget, no `id` field, no `result`.
 * @param def Definition to process.
 * @param def.name Wire method name.
 * @param def.params Schema for the request payload.
 * @returns The define notification result.
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
