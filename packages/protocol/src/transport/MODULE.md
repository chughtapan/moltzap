# protocol/transport

_`packages/protocol/src/transport`_

## Purpose

Public barrel for JSON-RPC transport descriptors and runtime helpers.

## Public surface

### [`_TypedDispatcherCanarySink`](./typed-dispatcher.types-check.ts#L201)

_TypeAlias_

```ts
export type _TypedDispatcherCanarySink =
  | typeof _shouldFailEmptyServer
  | typeof _shouldFailCtx
  | typeof _ctxBSlot
  | typeof _serverOutboundReject
  | typeof _serverOutboundOk1
  | typeof _serverOutboundOk2
  | typeof _agentClientEmpty
  | typeof _tmHandlersSink
  | typeof _tmEmpty
  | typeof _directReject
  | typeof _messagesListSlotWithExtraCap
  | typeof _capLockstepReject
  | typeof _messagesListSlotProper
  | typeof _capLockstepAccept
  | _ServerConnection
  | _AgentClientConnection
  | _TaskMasterConnection;
```

### [`AgentClientConnection`](./connection.ts#L162)

_Interface_

```ts
export interface AgentClientConnection
  extends ConnectionIdentity,
    OutboundCall<AnyAgentClientRpcDefinition>,
```

`AgentClientConnection` — plain agent client. Outbound surface is
the full `serverRpcMethods` catalog. Outbound notifications: none
(clients consume notifications; they do not originate them) — the
`notify` method is typed `never`, which fails any call site. No
inbound surface (the AgentClient kind's inbound catalog is empty).

### [`AgentClientConnectionConfig`](./connection.ts#L229)

_Interface_

```ts
export interface AgentClientConnectionConfig<
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly id: string;
  readonly handlers: AgentClientHandlers<Ctx, Caps>;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}
```

Equivalent config for the AgentClient factory. `handlers` is the
empty table; the factory accepts it for forward compatibility (if a
future spec adds AgentClient-inbound RPCs, the type system demands
coverage).

### [`AgentClientHandlers`](./handlers.ts#L117)

_TypeAlias_

```ts
export type AgentClientHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<never, Ctx, Caps>;
```

`AgentClientHandlers` — handler table for a plain agent client. The
inbound catalog is empty (an AgentClient receives notifications + RPC
responses; server-initiated RPCs go to a TM, not a generic client).
Resolves to `{}` so the literal `{}` is always well-typed; future
AgentClient-inbound RPC additions extend the catalog and propagate
through this alias.

The `Ctx` / `Caps` generics are retained so future
AgentClient-inbound RPC additions get the same Ctx/Caps threading
as Server and TM. The mapped type evaluates to `{}` when the
catalog union is `never`, satisfying both knip and the type's intent.

### [`ajv`](./wire.ts#L19)

_Variable_

```ts
export const ajv:
```

### [`buildAgentClientDispatcher`](./dispatch.ts#L127)

_Function_

```ts
export function buildAgentClientDispatcher<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: AgentClientConnectionConfig<Ctx, Caps>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope>
```

Build the agent-client dispatcher. Wires the originator only (no
inbound dispatch — the AgentClient kind's inbound catalog is empty).
The empty `notify` shape is `never`-typed at the type level (no
call site can satisfy the constraint).

### [`buildServerDispatcher`](./dispatch.ts#L98)

_Function_

```ts
export function buildServerDispatcher<Ctx, Caps extends Context.Tag<any, any>>(
  config: ServerConnectionConfig<Ctx, Caps>,
): Effect.Effect<ServerConnection<Ctx>, never, Scope.Scope>
```

Build the server-side dispatcher. Wires the inbound static-table
dispatch loop + the outbound originator (TM-callback path) into a
single `ServerConnection` value.

### [`buildTaskMasterDispatcher`](./dispatch.ts#L158)

_Function_

```ts
export function buildTaskMasterDispatcher<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: TaskMasterConnectionConfig<Ctx, Caps>,
): Effect.Effect<TaskMasterConnection<Ctx>, never, Scope.Scope>
```

Build the TM dispatcher. Wires both the inbound dispatch loop
(against `taskCallbackMethods`) and the outbound originator (against
`serverRpcMethods`). Spec D3 R14b made every TM-inbound slot
REQUIRED: callers must register a handler for each catalog method;
vacuous-deny moderators bind an explicit `ForbiddenError` handler.

### [`CapabilitiesOf`](./capabilities.ts#L76)

_TypeAlias_

```ts
export type CapabilitiesOf<D> = D extends {
  readonly capabilities: ReadonlyArray<infer Cap>;
}
```

Type-level extractor: union of capability tags declared on definition `D`
via `D["capabilities"][number]["tag"]`. When `D["capabilities"]` is
absent (the spec F stub state, before impl-staff per-method updates),
resolves to `never` — the slot contributes no capability requirements.

### [`CapabilityDescriptor`](./capabilities.ts#L35)

_Interface_

```ts
export interface CapabilityDescriptor {
  readonly tag: AnyContextTag;
  readonly argsOf: (params: unknown, ctx: unknown) => unknown;
}
```

### [`CapabilityProviderTable`](./capabilities.ts#L56)

_TypeAlias_

```ts
export type CapabilityProviderTable<Caps extends Context.Tag<any, any>> = {
  readonly [Cap in Caps as Cap extends Context.Tag<infer Id, infer _Svc>
    ? Id extends string
      ? Id
      : never
    : never]: (
    args: unknown,
  ) => Effect.Effect<
    Cap extends Context.Tag<unknown, infer Svc> ? Svc : never,
    unknown,
    unknown
  >;
};
```

Provider-table type alias (Spec F G5). Keys are the capability tag's
`_tag` string; values are the obtain helper that produces the tag's
service value. Spec E #606 owns the inhabitants — Spec F consumes
them unchanged.

Spec E's obtain helpers have shape
`(args) =&gt; Effect.Effect&lt;Service, ObtainError, ObtainContext&gt;`. The
dispatcher invokes the provider, then threads
`Effect.provideServiceEffect(tag, providerEffect)` for each tag a
handler's definition declares.

Parameter `Caps` is the union of `Context.Tag` instances referenced
across all slots in the handler table; the factory rejects (TS2741) a
provider table missing any tag in `Caps`.

### [`CapsUnionOf`](./handlers.ts#L148)

_TypeAlias_

```ts
export type CapsUnionOf<T> = {
  [K in keyof T]: SlotCaps<T[K]>;
}[keyof T];
```

Capability-union extractor: union of every capability tag referenced
across all real `HandlerSlot` arms in the table. The factory's
signature uses this to demand a `CapabilityProviderTable&lt;CapsUnionOf&lt;T>>`.

### [`ConflictError`](./wire-errors.ts#L123)

_Class_

```ts
export class ConflictError extends Data.TaggedError(
  "Conflict",
)<RpcErrorPayload> {
  static readonly code = -32003;
  static readonly message = "Conflict";
}
```

Conflict on a resource (cross-cutting; e.g., duplicate registration).

### [`DecodedFrame`](./wire.ts#L139)

_TypeAlias_

```ts
export type DecodedFrame =
  | { readonly _tag: "Request"; readonly frame: RequestFrame }
```

### [`DecodedNotification`](./rpc-groups.ts#L47)

_TypeAlias_

```ts
export type DecodedNotification<
  D extends AnyNotificationDefinition,
  R = unknown,
> = D extends AnyNotificationDefinition
```

A decoded notification carries the discriminator + descriptor + typed
params + the original wire `jsonrpc`. It does NOT extend `NotificationFrame`
— re-encoding goes through `definition.encode(params)`, not by re-serializing
this struct, so the strict-additionalProperties wire schema stays unstuck.

The optional second parameter `R` narrows the `params` field to the refined
type — used by `MoltZapAgentClient.subscribe`'s user-defined-type-guard
overload (spec #596 / architect plan §5.2). The default sentinel
`unknown` resolves to the per-branch `NotificationParamsOf<D>` shape,
preserving the one-arg form for every existing consumer.

The default uses an `unknown` sentinel rather than `NotificationParamsOf<D>`
because TS does not distribute type-alias defaults through the
`D extends AnyNotificationDefinition` distributive conditional below —
a `NotificationParamsOf<D>` default would resolve once over the input
union and break per-branch params narrowing for `D` unions like
`DispatchesConsumed | DispatchesExpired`. Carrying `R` as a sentinel and
resolving inside the conditional keeps the original `params` shape per
distribution branch when the one-arg form is used.

### [`DecodedRpcRequest`](./rpc-groups.ts#L16)

_TypeAlias_

```ts
export type DecodedRpcRequest<D extends AnyServerRpcDefinition> =
```

### [`decodeFrame`](./wire.ts#L149)

_Function_

```ts
export function decodeFrame(
  parsed: unknown,
): Effect.Effect<DecodedFrame, FrameDecodeError>
```

### [`decodeNotification`](./rpc-groups.ts#L117)

_Function_

```ts
export function decodeNotification<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  definitions: Definitions,
  frame: NotificationFrame,
): Effect.Effect<
  DecodedNotification<Definitions[number]>,
  NotificationDecodeError
>
```

### [`decodeRpcParams`](./method.ts#L206)

_Function_

```ts
export function decodeRpcParams<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  data: unknown,
): Effect.Effect<Static<P>, RpcParamsDecodeError>
```

### [`decodeRpcRequest`](./rpc-groups.ts#L92)

_Function_

```ts
export function decodeRpcRequest<
  const Definitions extends readonly AnyServerRpcDefinition[],
>(
  definitions: Definitions,
  frame: RequestFrame,
): Effect.Effect<
  DecodedRpcRequest<Definitions[number]>,
  RpcRequestDecodeError
>
```

### [`decodeRpcResult`](./method.ts#L219)

_Function_

```ts
export function decodeRpcResult<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  definition: RpcDefinition<Name, P, R>,
  data: unknown,
): Effect.Effect<Static<R>, RpcResultDecodeError>
```

### [`defineNotification`](./method.ts#L177)

_Function_

```ts
export function defineNotification<
  Name extends string,
  P extends TSchema,
>(def: { name: Name; params: P }): NotificationDefinition<Name, P>
```

Sibling of defineRpc for server-to-client notifications.
Same pipeline minus the result schema and response encoder —
notifications are fire-and-forget, no `id` field, no `result`.

### [`defineRpc`](./method.ts#L96)

_Function_

```ts
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
}): RpcDefinition<Name, P, R> &
```

Create one wire method's frozen descriptor: name, schemas, AJV
validators, and per-descriptor request/response encoders. Every
wire boundary in moltzap is born from a single `defineRpc` call at
module-load time so AJV validators are compiled eagerly and the
runtime never re-parses schemas.

```mermaid
flowchart TD
  A["domain layer call site:<br>defineRpc{ name, params, result, capabilities? }"]
  A --> B["ajv.compile(params)<br>→ validateParams"]
  A --> C["ajv.compile(result)<br>→ validateResult"]
  B --> D["RpcDefinition&lt;Name, P, R&gt;"]
  C --> D
  D --> E["pushed into per-layer *RpcMethods const"]
  E --> F["aggregated into rpcMethods"]
```

- Every slot is REQUIRED in the handler table (Spec D3 R14b);
  omitting any key fails TS2741 at the factory call.
- `capabilities` absent → no auto-provision; the dispatcher reads
  `definition.capabilities` per frame and threads
  `Effect.provideServiceEffect` for each entry.

Method names are branded `JsonRpcMethod&lt;"the.name">` so a runtime
string can never accidentally type-fit a method position. See
`wire.ts → JsonRpcMethod` for the brand.

Sibling: defineNotification — same pipeline minus the
result schema and response encoder.

### [`encodeErrorResponse`](./wire.ts#L225)

_Function_

```ts
export function encodeErrorResponse(
  id: JsonRpcId | null,
  error: ResponseFrameError,
): ResponseFrame
```

Public wire-error response encoder. Constructs a JSON-RPC error
response for any wire id (no method binding). Method-tied success
responses go through `RpcDefinition.encodeResponse`.

### [`errorClassFor`](./wire-errors.ts#L73)

_Function_

```ts
export function errorClassFor(code: number): RpcErrorClass | undefined
```

Returns the registered class for a wire code, or `undefined`.

### [`ForbiddenError`](./wire-errors.ts#L105)

_Class_

```ts
export class ForbiddenError extends Data.TaggedError(
  "Forbidden",
)<RpcErrorPayload> {
  static readonly code = -32001;
  static readonly message = "Forbidden";
}
```

Authenticated but not authorized for this resource.

### [`FrameDecodeError`](./wire.ts#L144)

_Class_

```ts
export class FrameDecodeError extends Data.TaggedError("FrameDecodeError")<{
  readonly raw: unknown;
  readonly id: JsonRpcId | null;
}> {}
```

### [`HandlerSlot`](./handlers.ts#L33)

_Interface_

```ts
export interface HandlerSlot<
  D extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown, Caps>;
}
```

Per-definition handler slot. `Ctx` is the dispatch context the
server side hands to every handler. `Caps` is the upper bound on
which `Context.Tag`s the handler's R channel may reference; the
dispatcher provides exactly these from the `CapabilityProviderTable`.

The Caps type-level gate (handler R channel ⊆ `CapabilitiesOf&lt;D&gt;`)
lives in `typed-dispatcher.types-check.ts`. The impl-staff PR
populates per-definition `capabilities` and the gate becomes
exercisable.

### [`HandlerTable`](./handlers.ts#L74)

_TypeAlias_

```ts
export type HandlerTable<
  Defs extends RpcDefinition<string, TSchema, TSchema>,
  Ctx,
  Caps extends Context.Tag<any, any>,
> = {
  readonly [D in Defs as NameOf<D>]: SlotValue<D, Ctx, Caps>;
};
```

Closed handler-table type generated from a definition union. Every
catalog member appears as a structurally-required key whose value is
a real `HandlerSlot&lt;D, Ctx, Caps&gt;` (Spec D3 R14b retired the
sentinel widening — no slot is optional).

Type-parameter erasure note: `RpcDefinition` is variant across `Name`
— the catalog `typeof serverRpcMethods[number]` resolves to a union of the
concrete `RpcDefinition&lt;"identity/register", ...>` etc. arms; the
mapped type preserves each arm's `name` literal so the resulting
table has named keys.

### [`InvalidParamsError`](./wire-errors.ts#L137)

_Class_

```ts
export class InvalidParamsError extends Data.TaggedError("InvalidParamsError")<{
  readonly message: string;
}> {
  static readonly code = JSON_RPC_RESERVED_CODES.InvalidParams;
  static readonly message = "Invalid params";
}
```

Boundary validation error — JSON-RPC reserved code -32602. Raised by
protocol- and server-layer handlers when params fail schema validation;
registered with the wire-error registry so handler-raised instances map
to a `-32602 InvalidParams` wire response via `wireErrorFromInstance`.

### [`isDecodedNotification`](./rpc-groups.ts#L147)

_Function_

```ts
export function isDecodedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<D>
```

### [`isRegisteredErrorInstance`](./wire-errors.ts#L78)

_Function_

```ts
export function isRegisteredErrorInstance(value: object): boolean
```

Returns true iff `value`'s constructor is in the registered class set.

### [`JSON_RPC_RESERVED_CODES`](./wire-errors.ts#L6)

_Variable_

```ts
export const JSON_RPC_RESERVED_CODES =
```

JSON-RPC 2.0 reserved codes. Emitted by TypedDispatcher; never raised by handlers.

### [`JSON_RPC_VERSION`](./wire.ts#L34)

_Variable_

```ts
export const JSON_RPC_VERSION = "2.0" as const
```

### [`JsonRpcId`](./wire.ts#L41)

_TypeAlias_

```ts
export type JsonRpcId = Static<typeof JsonRpcIdSchema>;
```

### [`jsonRpcMethod`](./wire.ts#L52)

_Function_

```ts
export const jsonRpcMethod = <const Name extends string>(
  method: Name,
): JsonRpcMethod<Name>
```

Internal factory for descriptor construction (`defineRpc`,
`defineNotification`). Not on the package barrel — callers pass plain
strings to frame builders, which brand internally.

### [`JsonRpcMethod`](./wire.ts#L42)

_TypeAlias_

```ts
export type JsonRpcMethod<Name extends string = string> = Name &
```

### [`makeAgentClientConnection`](./connection.ts#L280)

_Function_

```ts
export function makeAgentClientConnection<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: AgentClientConnectionConfig<Ctx, Caps>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope>
```

Factory — agent client. Delegates to `buildAgentClientDispatcher`
which wires the originator only (no inbound dispatch — the AgentClient
kind's inbound catalog is empty).

### [`makeOriginator`](./originator.ts#L227)

_Function_

```ts
export const makeOriginator = (config: {
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}): Effect.Effect<Originator, never, Scope.Scope>
```

### [`makeServerConnection`](./connection.ts#L269)

_Function_

```ts
export function makeServerConnection<Ctx, Caps extends Context.Tag<any, any>>(
  config: ServerConnectionConfig<Ctx, Caps>,
): Effect.Effect<ServerConnection<Ctx>, never, Scope.Scope>
```

Factory — server side. Delegates to `buildServerDispatcher`
(`dispatch.ts`) which wires:
  - inbound: per-frame dispatch via the static handler table; for
    each frame, the dispatcher reads the handler's
    `definition.capabilities` (Shape B), invokes the provider table's
    entry for each tag with the dispatcher-derived args, and threads
    `Effect.provideServiceEffect` over the handler effect.
  - outbound: an internalized originator (formerly the body of
    `makeOriginator`) that mints `${idPrefix}-N` ids and tracks
    pending Deferreds. Scope finalizer drains pending Deferreds with
    `NotConnectedError`.

### [`makeTaskMasterConnection`](./connection.ts#L300)

_Function_

```ts
export function makeTaskMasterConnection<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: TaskMasterConnectionConfig<Ctx, Caps>,
): Effect.Effect<TaskMasterConnection<Ctx>, never, Scope.Scope>
```

Factory — TaskMaster. Delegates to `buildTaskMasterDispatcher` which
wires both the inbound dispatch loop (against `taskCallbackMethods`)
and the outbound originator (against the full `serverRpcMethods` catalog).
Every TM-inbound slot is REQUIRED. Spec D3 R14b retired the optional
sentinel defaults the prior shape carried; the empty literal
`{ handlers: {} }` is REJECTED at the type level (TS2741 — see
Canary 6 in `typed-dispatcher.types-check.ts`). Vacuous-deny
moderators bind an explicit `ForbiddenError`-returning handler for
each catalog method.

### [`MalformedFrameError`](./wire-errors.ts#L146)

_Class_

```ts
export class MalformedFrameError extends Data.TaggedError(
  "MalformedFrameError",
)<{
  readonly raw: string;
  readonly cause?: unknown;
}> {}
```

Inbound frame failed to parse as JSON or did not match the expected shape.

### [`NotConnectedError`](./rpc-errors.ts#L17)

_Class_

```ts
export class NotConnectedError extends Data.TaggedError("NotConnectedError")<{
  readonly message: string;
}> {}
```

The socket is not in the OPEN state when an RPC was attempted.

### [`NotFoundError`](./wire-errors.ts#L114)

_Class_

```ts
export class NotFoundError extends Data.TaggedError(
  "NotFound",
)<RpcErrorPayload> {
  static readonly code = -32002;
  static readonly message = "Not found";
}
```

Resource not found (cross-cutting variant; domain-specific NotFound errors live with their domain).

### [`NotificationDecodeError`](./rpc-groups.ts#L88)

_TypeAlias_

```ts
export type NotificationDecodeError =
  | UnknownNotificationMethodError
  | InvalidNotificationParamsError;

export function decodeRpcRequest<
  const Definitions extends readonly AnyServerRpcDefinition[],
>(
  definitions: Definitions,
  frame: RequestFrame,
): Effect.Effect<
  DecodedRpcRequest<Definitions[number]>,
  RpcRequestDecodeError
> {
  const definition = definitions.find((d) => d.name === frame.method);
  if (definition === undefined) {
    return Effect.fail(new UnknownRpcMethodError({ frame }));
  }
  const params = frame.params ?? {};
  if (!definition.validateParams(params)) {
    return Effect.fail(new InvalidRpcParamsError({ frame, definition }));
  }
  return Effect.succeed({
    frame,
    id: frame.id,
    definition,
    params,
  } as DecodedRpcRequest<Definitions[number]>);
}
```

### [`NotificationDefinition`](./method.ts#L157)

_Interface_

```ts
export interface NotificationDefinition<
  Name extends string,
  P extends TSchema,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly validateParams: (data: unknown) => data is Static<P>;
  readonly encode: (params: unknown) => NotificationFrame;
}
```

A frozen descriptor for one server-to-client notification.
Notifications are fire-and-forget — no `id`, no response, no
pending-call registry. The transport-side runtimes don't track
them; consumers subscribe externally via per-method handlers.

```mermaid
sequenceDiagram
  participant Server
  participant Wire as WebSocket
  participant Client
  Server->>Server: NotificationDefinition.encode(params)
  Server->>Wire: {jsonrpc, method, params}
  Wire->>Client: frame arrives
  Client->>Client: decodeServerInbound<br>→ tag Notification, definition, params
  Client->>Client: subscriber dispatcher routes to handler
```

Descriptor role at the transport layer: encode + decode + schema
validation. Routing semantics live in consumers (e.g.
`@moltzap/client/runtime/subscribers.ts`).

### [`notificationFrame`](./wire.ts#L233)

_Function_

```ts
export function notificationFrame<Name extends string, P extends TSchema>(
  definition: NotificationDefinition<Name, P>,
  params: Static<P>,
): NotificationFrame &
```

### [`NotificationFrame`](./wire.ts#L113)

_TypeAlias_

```ts
export type NotificationFrame = Static<typeof NotificationFrameSchema>;
```

### [`notificationFrameSchema`](./wire.ts#L123)

_Function_

```ts
export function notificationFrameSchema(): typeof NotificationFrameSchema
```

### [`NotificationParamsOf`](./method.ts#L168)

_TypeAlias_

```ts
export type NotificationParamsOf<
  D extends NotificationDefinition<string, TSchema>,
> = D extends NotificationDefinition<string, infer P> ? Static<P> : never;
```

Type-only accessor for a notification's params payload.

### [`Originator`](./originator.ts#L32)

_Interface_

```ts
export interface Originator {
  readonly call: <D extends AnyServerRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
  readonly resolve: (frame: ResponseFrame) => Effect.Effect<boolean>;
  readonly failAllPending: (error: NotConnectedError) => Effect.Effect<void>;
}
```

Originator side of a JSON-RPC connection. Scope-bound: closing the
scope runs `failAllPending(NotConnectedError)`. Caller owns timeouts.

### [`ParamsOf`](./method.ts#L58)

_TypeAlias_

```ts
export type ParamsOf<D extends RpcDefinition<string, TSchema, TSchema>> =
```

Type-only accessor for a definition's params payload.

### [`registerErrorClass`](./wire-errors.ts#L61)

_Function_

```ts
export function registerErrorClass(cls: RpcErrorClass): void
```

Register a tagged-error class so the originator can resurrect it
from a wire `error` payload by code. Each registered class carries
`static readonly code: number` and `static readonly message:
string`; both are read at registration time. Throws
`DuplicateErrorCodeError` at module-load if two classes claim the
same code.

```mermaid
flowchart LR
  A["domain module load:<br>class FooError extends Data.TaggedError(...)<br>static code = -32019<br>registerErrorClass(FooError)"]
  A --> B["codeToClass.set(-32019, FooError)"]
  B --> C["client side: errorClassFor(code)<br>→ FooError instance | undefined"]
  C --> D["caller: Effect.catchTag('Foo', ...)"]
  B --> E["server side: wireErrorFromInstance<br>→ wire 'error' sub-object"]
```

`JSON_RPC_RESERVED_CODES` covers only the five JSON-RPC 2.0 spec
codes (-32700, -32600, -32601, -32602, -32603). Every other code
lives in the runtime registry, not in a central table. The
`RegisteredTaggedError` union in `rpc-registry.ts` mirrors the
registered classes and must be hand-kept in sync — the TS type
system cannot enumerate the static-side registry into a union.

### [`requestFrame`](./wire.ts#L169)

_Function_

```ts
export function requestFrame<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(
  id: string,
  definition: RpcDefinition<Name, P, R>,
  params: Static<P>,
): RequestFrame &
```

### [`RequestFrame`](./wire.ts#L111)

_TypeAlias_

```ts
export type RequestFrame = Static<typeof RequestFrameSchema>;
```

### [`requestFrameSchema`](./wire.ts#L115)

_Function_

```ts
export function requestFrameSchema(): typeof RequestFrameSchema
```

### [`responseFrame`](./wire.ts#L201)

_Function_

```ts
export function responseFrame(
  id: string | null,
  body: ResponseFrameBody,
): ResponseFrame
```

### [`ResponseFrame`](./wire.ts#L112)

_TypeAlias_

```ts
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
```

### [`ResponseFrameBody`](./wire.ts#L197)

_TypeAlias_

```ts
export type ResponseFrameBody =
  | { result: unknown }
```

### [`responseFrameSchema`](./wire.ts#L119)

_Function_

```ts
export function responseFrameSchema(): typeof ResponseFrameSchema
```

### [`ResultOf`](./method.ts#L62)

_TypeAlias_

```ts
export type ResultOf<D extends RpcDefinition<string, TSchema, TSchema>> =
```

Type-only accessor for a definition's result payload.

### [`RpcCallError`](./originator.ts#L23)

_TypeAlias_

```ts
export type RpcCallError =
  | NotConnectedError
  | RpcServerError
  | RegisteredTaggedError;

/**
 * Originator side of a JSON-RPC connection. Scope-bound: closing the
 * scope runs `failAllPending(NotConnectedError)`. Caller owns timeouts.
 */
export interface Originator {
  readonly call: <D extends AnyServerRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
  readonly resolve: (frame: ResponseFrame) => Effect.Effect<boolean>;
  readonly failAllPending: (error: NotConnectedError) => Effect.Effect<void>;
}
```

### [`RpcDefinition`](./method.ts#L29)

_Interface_

```ts
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
```

Typed manifest for one RPC method: wire name + schemas + validators.
Type-only payload accessors are exposed via `ParamsOf&lt;D>`/`ResultOf&lt;D>`
— there is no runtime `Params`/`Result` property.

`capabilities` is the only optional metadata: a runtime-readable list
of capability descriptors the dispatcher iterates to thread
`Effect.provideServiceEffect`. Each descriptor names a `Context.Tag`
plus an `argsOf` resolver that derives the obtain helper's args from
`params` + `ctx`. Absent → no capabilities.

### [`RpcErrorClass`](./wire-errors.ts#L21)

_TypeAlias_

```ts
export type RpcErrorClass = (new (
  ...args: never[]
) => {
  readonly _tag: string;
}) & {
  readonly code: number;
  readonly message: string;
};
```

A `Data.TaggedError`-derived class with static wire metadata
(`code` + `message`). The typed dispatcher reads
`err.constructor.code` to encode outbound error responses; the
originator looks up the class by code via `errorClassFor` for inbound
response decode.

### [`RpcErrorPayload`](./wire-errors.ts#L88)

_Interface_

```ts
export interface RpcErrorPayload {
  readonly message?: string;
  readonly data?: JsonValue;
}
```

Optional per-instance overrides for tagged-error classes. The static
`message` on the class is the default; instances may carry a more
specific message and/or supplemental `data` payload that TypedDispatcher
forwards to the wire response.

### [`RpcParamsDecodeError`](./method.ts#L192)

_Class_

```ts
export class RpcParamsDecodeError extends Data.TaggedError(
  "RpcParamsDecodeError",
)<{
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
  readonly data: unknown;
}> {}
```

### [`RpcRequestDecodeError`](./rpc-groups.ts#L71)

_TypeAlias_

```ts
export type RpcRequestDecodeError =
  | UnknownRpcMethodError
  | InvalidRpcParamsError;

class UnknownNotificationMethodError extends Data.TaggedError(
  "UnknownNotificationMethodError",
)<{
  readonly frame: NotificationFrame;
}> {}
```

### [`RpcResultDecodeError`](./method.ts#L199)

_Class_

```ts
export class RpcResultDecodeError extends Data.TaggedError(
  "RpcResultDecodeError",
)<{
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
  readonly data: unknown;
}> {}
```

### [`RpcServerError`](./rpc-errors.ts#L28)

_Class_

```ts
export class RpcServerError extends Data.TaggedError("RpcServerError")<{
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}
```

The peer returned an `error` response frame.

### [`RpcTimeoutError`](./rpc-errors.ts#L22)

_Class_

```ts
export class RpcTimeoutError extends Data.TaggedError("RpcTimeoutError")<{
  readonly method: JsonRpcMethod;
  readonly timeoutMs: number;
}> {}
```

The RPC exceeded the per-call timeout without a response frame.

### [`ServerConnection`](./connection.ts#L149)

_Interface_

```ts
export interface ServerConnection<Ctx = unknown, R = never>
```

`ServerConnection` — server side. Outbound surface is the
`AnyTaskCallbackRpcDefinition` union: the server may call INTO a TM
for `DispatchAuthorize` and `MessagesAuthorize`. Outbound notifications
are the full `AnyNotificationDefinition` set (the server originates
delivery + lifecycle notifications). Inbound surface is the closed
`serverRpcMethods` catalog, dispatched via the static `ServerHandlers` table.

### [`ServerConnectionConfig`](./connection.ts#L210)

_Interface_

```ts
export interface ServerConnectionConfig<
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly id: string;
  readonly handlers: ServerHandlers<Ctx, Caps>;
  readonly capabilities: CapabilityProviderTable<
    CapsArg<ServerHandlers<Ctx, Caps>>
  >;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}
```

Config record consumed by `makeServerConnection`. `Caps` is inferred
by TypeScript from the handler-table literal — callers normally
write `makeServerConnection({ handlers: { ... }, capabilities: { ... } })`
and TypeScript reconstructs `Caps` from the slots' definitions.

`write` is the wire-level write effect the surrounding transport
supplies; `idPrefix` mirrors `makeOriginator`'s idPrefix convention
for the outbound TM-callback path.

### [`ServerHandlers`](./handlers.ts#L99)

_TypeAlias_

```ts
export type ServerHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<ServerInboundRpcDefinition, Ctx, Caps>;
```

`ServerHandlers` — handler table for the server side. `Ctx` defaults
to the dispatch context the server's `defineMethod` wrapper exposes
(see `packages/server/src/transport/context.ts → DispatchContext`).
`Caps` is the union of `Context.Tag` instances the table's slots
declare; the factory infers it from the literal.

### [`ServerInboundRpcDefinition`](./handlers.ts#L89)

_TypeAlias_

```ts
export type ServerInboundRpcDefinition = (typeof serverRpcMethods)[number] &
```

Server-side inbound RPC catalog — every method an agent client may
call into the server. LSP-anchored: the catalog is `serverRpcMethods` from
`rpc-registry.ts`, which composes `identityRpcMethods`,
`networkRpcMethods`, `taskRpcMethods`, and `appRpcMethods`. 42
members at `227c398`.

### [`TaskMasterConnection`](./connection.ts#L184)

_Interface_

```ts
export interface TaskMasterConnection<Ctx = unknown, R = never>
```

`TaskMasterConnection` — agent acting as TM. Outbound surface is the
full `serverRpcMethods` catalog (a TM is a superset of an AgentClient at the
type level). Outbound notifications: none. Inbound surface is the
`taskCallbackMethods` catalog, dispatched via the static
`TaskMasterHandlers` table; every slot is a REQUIRED real handler
(Spec D3 R14b retired the optional `forbidden` / `noOpNotification`
sentinels), so vacuous-deny moderators must bind an explicit
`ForbiddenError`-returning handler per catalog method.

### [`TaskMasterConnectionConfig`](./connection.ts#L243)

_Interface_

```ts
export interface TaskMasterConnectionConfig<
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly id: string;
  readonly handlers: TaskMasterHandlers<Ctx, Caps>;
  readonly capabilities: CapabilityProviderTable<
    CapsArg<TaskMasterHandlers<Ctx, Caps>>
  >;
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}
```

Config for the TaskMaster factory. The TM owns the `taskCallbackMethods`
catalog inbound; its outbound surface is the full `serverRpcMethods` catalog.

### [`TaskMasterHandlers`](./handlers.ts#L133)

_TypeAlias_

```ts
export type TaskMasterHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<TaskMasterInboundRpcDefinition, Ctx, Caps>;
```

### [`TaskMasterInboundRpcDefinition`](./handlers.ts#L131)

_TypeAlias_

```ts
export type TaskMasterInboundRpcDefinition = AnyTaskCallbackRpcDefinition;

export type TaskMasterHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<TaskMasterInboundRpcDefinition, Ctx, Caps>;
```

`TaskMasterHandlers` — handler table for an agent acting as TM for
one or more tasks. Catalog: `taskCallbackMethods` —
`DispatchAuthorize`, `MessagesAuthorize`, `TaskCreate`. All three
REQUIRED (R14b); vacuous-deny moderators must write the handler
explicitly. `TaskCreate` is the server-initiated callback fired
after `task/request` lands the task in `waiting`; the TM's typed
verdict drives the lifecycle transition.

### [`UnauthorizedError`](./wire-errors.ts#L96)

_Class_

```ts
export class UnauthorizedError extends Data.TaggedError(
  "Unauthorized",
)<RpcErrorPayload> {
  static readonly code = -32000;
  static readonly message = "Not authenticated. Send network/connect first.";
}
```

### [`validateNotificationFrame`](./wire.ts#L133)

_Variable_

```ts
export const validateNotificationFrame = ajv.compile(
  NotificationFrameSchema,
) as (v: unknown)
```

### [`validateRequestFrame`](./wire.ts#L127)

_Variable_

```ts
export const validateRequestFrame = ajv.compile(RequestFrameSchema) as (
  v: unknown,
)
```

### [`validateResponseFrame`](./wire.ts#L130)

_Variable_

```ts
export const validateResponseFrame = ajv.compile(ResponseFrameSchema) as (
  v: unknown,
)
```

### [`wireErrorFromInstance`](./dispatch.ts#L482)

_Function_

```ts
export function wireErrorFromInstance(value: unknown): WireError | null
```

Reads wire metadata (code/message/data) off an `RpcErrorClass` instance.
Returns `null` when the failure isn't a registered wire-error class
(caller routes to InternalError).

## Files

- `capabilities.ts`
- `connection.ts`
- `dispatch.ts`
- `handlers.ts`
- `method.ts`
- `originator.ts`
- `rpc-errors.ts`
- `rpc-groups.ts`
- `typed-dispatcher.types-check.ts`
- `wire-errors.ts`
- `wire.ts`
