/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Brand, Data, Effect, Schema } from "effect";
import { closedStructGuard } from "../schema-primitives.js";
import type { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";

export type JsonRpcMethod<Name extends string = string> = Name &
  Brand.Brand<"JsonRpcMethod">;

export type JsonRpcId = string & Brand.Brand<"JsonRpcId">;

const JsonRpcMethodBrand = Brand.nominal<JsonRpcMethod>();

/**
 * Internal factory for descriptor construction (`defineRpc`,
 * `defineNotification`). Callers pass plain strings to descriptors, which brand
 * them here so method positions cannot accidentally accept arbitrary strings.
 */
export const jsonRpcMethod = <const Name extends string>(
  method: Name,
): JsonRpcMethod<Name> => JsonRpcMethodBrand(method) as JsonRpcMethod<Name>;

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
 * The STRUCTURAL shape of one `requires` entry at the wire layer: a requirement
 * tag carries a `key` (its `Context.Tag` identifier) and a `static errors` tuple
 * the descriptor folds into the wire error union. The descriptor factory needs
 * only this shape — it reads `.errors` and treats the tag as an opaque marker.
 *
 * The GENUINE closed union of the actual requirement tags (principal | claimed |
 * capability) and the compile-error-on-unregistered-cap guarantee live in the
 * engine layer (`engine/requirements.ts` → `Requirement` / `capRequirementsOf`),
 * above the domains: that is where a cap with no registered middleware fails to
 * compile, at the engine-member binding. Keeping the wire-layer constraint
 * structural is what lets the domains call `defineRpc` without the wire layer
 * importing the capability tags upward.
 */
export type RequirementShape = {
  readonly key: string;
  readonly errors: ReadonlyArray<RpcErrorClass>;
};

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
 * `requires` is the ONE authority axis: the client groups partition on its head
 * (the principal requirement), the server stacks one `RpcMiddleware` per
 * requirement, and the descriptor folds each requirement's `errors` into the
 * effective wire error union.
 */
export interface RpcDefinition<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  Requires extends
    ReadonlyArray<RequirementShape> = ReadonlyArray<RequirementShape>,
  Errs extends ReadonlyArray<RpcErrorClass> = ReadonlyArray<RpcErrorClass>,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly resultSchema: R;

  /**
   * The ordered authority list. The FIRST element is exactly one principal
   * requirement (`AgentPrincipal` | `AppPrincipal`); an optional `AgentClaimed`
   * refinement (agent-only) follows; the rest are capability tags, in run
   * order. Empty for the lone unauthenticated method (`network/connect`). The
   * client groups partition on the head; the server stacks one `RpcMiddleware`
   * per element; each element's `errors` fold into the wire error union.
   */
  readonly requires: Requires;

  /**
   * The handler-domain tagged-error classes this method can fail with — only
   * the errors the HANDLER raises, not the requirement (principal/cap) errors
   * (those come from each requirement's own `errors`). The method's effective
   * wire error union is the dedup'd union of both; see
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
 * The union of every requirement's error instances for a `requires` tuple: each
 * requirement (principal, agent-claimed refinement, capability) declares its own
 * `static errors`, read directly off each entry's {@link RequirementShape} (no
 * structural cast). The lone empty `requires` (`network/connect`) yields `never`.
 */
export type RequirementErrorsOf<
  Requires extends ReadonlyArray<RequirementShape>,
> = InstanceType<Requires[number]["errors"][number]>;

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
    ReadonlyArray<RequirementShape>,
    infer Errs
  >
    ? InstanceType<Errs[number]>
    : never;

/**
 * The full typed error channel of a per-method call: the method's handler-domain
 * errors, every requirement's declared errors, plus the always-possible
 * transport errors. This is exactly what the typed client surfaces on
 * `client["method/name"](payload)`'s Effect — the same union the wire
 * `errorSchema` decodes, plus transport.
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
    infer Requires,
    ReadonlyArray<RpcErrorClass>
  >
    ? DomainErrorsOf<D> | RequirementErrorsOf<Requires> | ResponseErrorsOf
    : never;

/**
 * The effective wire-error class list for a method: every requirement's declared
 * errors (in `requires` order) then the handler-domain errors, deduped by
 * identity (a class shared across a requirement and the handler list appears
 * once). This is the single source the wire `errorSchema`, the server gate, and
 * the typed client all read.
 */
export function effectiveErrorClasses(
  requires: ReadonlyArray<RequirementShape>,
  handlerErrors: ReadonlyArray<RpcErrorClass>,
): ReadonlyArray<RpcErrorClass> {
  const all = [...requires.flatMap(requirementErrorClasses), ...handlerErrors];
  return [...new Set(all)];
}

/**
 * Read a requirement tag's declared static `errors` — read directly off its
 * {@link RequirementShape} (every requirement tag has `static errors`), the
 * runtime mirror of {@link RequirementErrorsOf}.
 */
function requirementErrorClasses(
  req: RequirementShape,
): ReadonlyArray<RpcErrorClass> {
  return req.errors;
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
 * Method names are branded `JsonRpcMethod&lt;"the.name">` so a runtime
 * string can never accidentally type-fit a method position.
 *
 * Sibling: {@link defineNotification} — same pipeline minus the
 * result schema and the error union.
 */
export function defineRpc<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
  const Requires extends ReadonlyArray<RequirementShape> = readonly [],
  const Errs extends ReadonlyArray<RpcErrorClass> = readonly [],
>(def: {
  name: Name;
  params: P;
  result: R;

  /**
   * REQUIRED. The ordered authority list. The FIRST element is exactly one
   * principal requirement (`AgentPrincipal` | `AppPrincipal`); an optional
   * `AgentClaimed` refinement (agent-only) follows; the rest are capability
   * tags, in run order. The public `network/connect` is the lone method with
   * `requires: []`. Each requirement folds its declared `errors` into the
   * method's effective wire error union.
   */
  requires: Requires;

  /**
   * REQUIRED. The handler-domain tagged-error classes this method can fail
   * with — only what the handler itself raises. The principal-gate errors
   * (`Unauthorized`/`Forbidden` for authenticated methods) and each cap's own
   * `errors` are added automatically. A method with no handler-domain error
   * declares `[]`.
   */
  errors: Errs;
}): RpcDefinition<Name, P, R, Requires, Errs> {
  const d: RpcDefinition<Name, P, R, Requires, Errs> = {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    resultSchema: def.result,
    requires: def.requires,
    errors: def.errors,
    // The per-method wire error union the engine encodes/decodes against: every
    // requirement's declared errors ∪ the handler's declared errors, deduped,
    // discriminated by `_tag`.
    errorSchema: makeErrorSchema(
      effectiveErrorClasses(def.requires, def.errors),
    ),
    // Handler-domain errors ALONE: the engine member's `error`. The requirement
    // (principal/cap) errors come from the stacked middlewares' `failure`.
    handlerErrorSchema: makeErrorSchema(def.errors),
    validateParams: closedStructGuard(def.params),
    validateResult: closedStructGuard(def.result),
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
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly validateParams: (data: unknown) => data is Schema.Schema.Type<P>;
}

/** Type-only accessor for a notification's params payload. */
export type NotificationParamsOf<
  D extends NotificationDefinition<string, Schema.Schema.AnyNoContext>,
> =
  D extends NotificationDefinition<string, infer P>
    ? Schema.Schema.Type<P>
    : never;

/**
 * Descriptor-tagged notification delivery after native Effect RPC/Schema
 * decode. This is the broad-subscription shape; typed subscriptions consume
 * `NotificationParamsOf<D>` directly.
 */
export interface NotificationDelivery<
  D extends NotificationDefinition<
    string,
    Schema.Schema.AnyNoContext
  > = NotificationDefinition<string, Schema.Schema.AnyNoContext>,
> {
  readonly definition: D;
  readonly method: D["name"];
  readonly params: NotificationParamsOf<D>;
}

/**
 * Sibling of {@link defineRpc} for server-to-client notifications.
 * Same pipeline minus the result schema — notifications are
 * fire-and-forget, no `id` field, no `result`.
 */
export function defineNotification<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
>(def: { name: Name; params: P }): NotificationDefinition<Name, P> {
  return {
    name: jsonRpcMethod(def.name),
    paramsSchema: def.params,
    validateParams: closedStructGuard(def.params),
  };
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
