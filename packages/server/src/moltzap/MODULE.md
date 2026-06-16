# server-core/moltzap

_`packages/server/src/moltzap`_

## Purpose

Server-side MoltZap protocol adapter surface.

## Public surface

### [`agentArm`](./handler-runtime.ts#L44)

_Variable_

```ts
export const agentArm: Effect.Effect<
  AgentContext,
  never,
  ConnectionTag | ConnectionManagerTag
> = Effect.gen(function* () {
  const connection = yield* liveArm;
  if (connection._tag !== "AgentConnection") {
    return yield* Effect.dieMessage(
      `handler: agent-gated method reached on ${connection._tag} arm`,
    );
  }
  return connection.auth;
}).pipe(Effect.withSpan("serverHandlers.agentArm"))
```

Read the request-scoped agent context for a handler whose principal
gate narrowed the arm to `"agent"`. A non-agent arm is an impossible-state
defect: the gate runs before the handler, so reaching here off a non-agent arm
means the engine ran a handler whose middleware should have rejected the frame.

### [`appArm`](./handler-runtime.ts#L63)

_Variable_

```ts
export const appArm: Effect.Effect<
  AppContext,
  never,
  ConnectionTag | ConnectionManagerTag
> = Effect.gen(function* () {
  const connection = yield* liveArm;
  if (connection._tag !== "AppConnection") {
    return yield* Effect.dieMessage(
      `handler: app-gated method reached on ${connection._tag} arm`,
    );
  }
  return connection.auth;
}).pipe(Effect.withSpan("serverHandlers.appArm"))
```

Read the request-scoped app context for a handler whose principal gate
narrowed the arm to `"app"`. A non-app arm is an impossible-state defect for
the same reason as agentArm.

### [`AppTags`](./layer-tags.ts#L97)

_TypeAlias_

```ts
export type AppTags =
  | TaskTags
  | AppEndpointRegistryTag
  | DispatchAdmissionServiceTag;
```

App-layer allowlist: dispatch admission and connected app registration.

### [`makeMoltzapSocketHandler`](./server-socket.ts#L17)

_Function_

```ts
export function makeMoltzapSocketHandler(options: {
  readonly services: ResolvedServices;
  readonly disconnectionHooks: readonly DisconnectionHook[];
})
```

### [`makeRequirementMiddlewareLayers`](./auth-middleware-layers.ts#L347)

_Function_

```ts
export const makeRequirementMiddlewareLayers = (connId: ConnectionId)
```

Every per-socket requirement impl Layer, merged. The engine stacks each
requirement on the methods that declare it. `ConversationInTask` reads no
caller (pure params — it gates app-principal methods too); the rest peek the
caller's agent id.

### [`narrowByPolicy`](./principal-gate.ts#L99)

_Function_

```ts
export const narrowByPolicy = (
  principal: PrincipalRequirement | undefined,
  requireActiveAgent: boolean,
  connection: Connection,
): Effect.Effect<Principal, ForbiddenError>
```

Narrow the live arm to the principal a gated method's `requires` head demands.
A gated method always has a principal head: the empty-`requires` Connect path
carries no policy and never reaches this gate, so an `undefined` head here is a
wiring defect, not a caller-actionable error.

### [`peekLiveArm`](./principal-gate.ts#L44)

_Function_

```ts
export const peekLiveArm = (
  manager: ConnectionManager,
  connId: ConnectionId,
): Effect.Effect<Connection>
```

Peek the live arm by `connId` off the shared manager. A missing entry is an
impossible-state defect: the socket-open path inserts the unauthenticated arm
before any resolver Layer is built in the same scope, and the close finalizer
removes it only as that scope tears down.

### [`serverHandlers`](./handler-catalog.ts#L39)

_Variable_

```ts
export const serverHandlers: ServerHandlers =
```

The handler map. Keys are the wire method names of every WS-dispatched
method; values are the per-method handler bodies.

## Files

- `auth-middleware-layers.ts`
- `handler-catalog.ts`
- `handler-runtime.ts`
- `layer-tags.ts`
- `principal-gate.ts`
- `server-socket.ts`
