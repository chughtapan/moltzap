# protocol/network

_`packages/protocol/src/network`_

## Purpose

Public barrel for connect and presence protocol descriptors.

## Public surface

### [`agentCallableNetworkRpcMethods`](./index.ts#L21)

_Variable_

```ts
export const agentCallableNetworkRpcMethods = [
  AgentConnect,
  AgentPresenceSubscribe,
] as const
```

Network RPCs callable by agent clients.

### [`AgentConnect`](./connect.ts#L171)

_Variable_

```ts
export const AgentConnect = defineRpc({
  name: "agent/network/connect",
  params: Schema.Struct({
    agentKey: AgentKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: HelloOkSchema,
  requires: [],
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
})
```

Authenticate an agent WebSocket connection. Must be the first message on a
new agent client connection.

- **Principal:** none — the unauthenticated handshake. No principal exists
  pre-auth, so `requires` is empty and no gate runs before it.
- **Params:** `agentKey`, `minProtocol`, `maxProtocol`.
- **Result:** an empty HelloOk; success is the signal (the client holds its
  own id).

**Returns:** An empty HelloOk; success is the signal (the client holds its own id).

### [`AgentPresenceSubscribe`](./presence.ts#L35)

_Variable_

```ts
export const AgentPresenceSubscribe = defineRpc({
  name: "agent/network/presence/subscribe",
  params: PresenceSubscribeParamsSchema,
  result: PresenceSubscribeResultSchema,
  requires: [AgentPrincipal],
  errors: [NotInContactsError],
})
```

### [`appCallableNetworkRpcMethods`](./index.ts#L27)

_Variable_

```ts
export const appCallableNetworkRpcMethods = [
  AppConnect,
  AppPresenceSubscribe,
] as const
```

Network RPCs callable by app clients.

### [`AppConnect`](./connect.ts#L203)

_Variable_

```ts
export const AppConnect = defineRpc({
  name: "app/network/connect",
  params: Schema.Struct({
    appKey: AppKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: HelloOkSchema,
  requires: [],
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
})
```

Authenticate an app WebSocket connection. Must be the first message on a new
app client connection.

- **Principal:** none — the unauthenticated handshake. No principal exists
  pre-auth, so `requires` is empty and no gate runs before it.
- **Params:** `appKey`, `minProtocol`, `maxProtocol`.
- **Result:** an empty HelloOk; success is the signal (the client holds its
  own id).

**Returns:** An empty HelloOk; success is the signal (the client holds its own id).

### [`AppPresenceSubscribe`](./presence.ts#L43)

_Variable_

```ts
export const AppPresenceSubscribe = defineRpc({
  name: "app/network/presence/subscribe",
  params: PresenceSubscribeParamsSchema,
  result: PresenceSubscribeResultSchema,
  requires: [AppPrincipal],
  errors: [],
})
```

### [`checkProtocolRange`](./connect.ts#L99)

_Function_

```ts
export function checkProtocolRange(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  serverVersion: string,
): Effect.Effect<void, ProtocolMismatchError | InvalidProtocolVersionError>
```

### [`compareProtocolVersion`](./connect.ts#L86)

_Function_

```ts
export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1
```

### [`HelloOk`](./connect.ts#L26)

_TypeAlias_

```ts
export type HelloOk = Schema.Schema.Type<typeof HelloOkSchema>;
```

### [`InvalidProtocolVersionError`](./connect.ts#L64)

_Class_

```ts
export class InvalidProtocolVersionError extends Data.TaggedError(
  "InvalidProtocolVersionError",
)<{ readonly version: string; readonly segment: string }> {
  override get message(): string {
    return `compareProtocolVersion: invalid segment ${JSON.stringify(this.segment)} in ${JSON.stringify(this.version)}`;
  }
}
```

### [`networkNotifications`](./index.ts#L41)

_Variable_

```ts
export const networkNotifications = [] as const
```

Network notifications emitted by the server.

### [`networkRpcMethods`](./index.ts#L33)

_Variable_

```ts
export const networkRpcMethods = [
  AgentConnect,
  AppConnect,
  AgentPresenceSubscribe,
  AppPresenceSubscribe,
] as const
```

Network RPCs accepted by the server.

### [`PROTOCOL_VERSION`](./connect.ts#L12)

_Variable_

```ts
export const PROTOCOL_VERSION = "2026.529.0"
```

### [`ProtocolMismatchError`](./connect.ts#L46)

_Class_

```ts
export class ProtocolMismatchError extends Schema.TaggedError<ProtocolMismatchError>()(
  "ProtocolMismatchError",
  {
    message: Schema.optional(Schema.String),
    data: Schema.Struct({
      reason: Schema.Literal(
        "server-above-client-max",
        "server-below-client-min",
      ),
      serverVersion: Schema.String,
      clientMinProtocol: Schema.String,
      clientMaxProtocol: Schema.String,
    }),
  },
) {
  static readonly message = "Client protocol version not supported";
}
```

Raised by connect methods when the client's `[minProtocol, maxProtocol]`
range does not bracket the server's `PROTOCOL_VERSION`. The server's connect
handlers raise it BEFORE auth resolution
so old clients are rejected at the version gate. `data` carries the
diagnostic `{ reason, serverVersion, clientMinProtocol, clientMaxProtocol }`,
concretely typed so `error.data.reason` narrows at every reader.

### [`ProtocolMismatchReason`](./connect.ts#L34)

_TypeAlias_

```ts
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";

/**
 * Raised by connect methods when the client's `[minProtocol, maxProtocol]`
 * range does not bracket the server's `PROTOCOL_VERSION`. The server's connect
 * handlers raise it BEFORE auth resolution
 * so old clients are rejected at the version gate. `data` carries the
 * diagnostic `{ reason, serverVersion, clientMinProtocol, clientMaxProtocol }`,
 * concretely typed so `error.data.reason` narrows at every reader.
 */
export class ProtocolMismatchError extends Schema.TaggedError<ProtocolMismatchError>()(
  "ProtocolMismatchError",
  {
    message: Schema.optional(Schema.String),
    data: Schema.Struct({
      reason: Schema.Literal(
        "server-above-client-max",
        "server-below-client-min",
      ),
      serverVersion: Schema.String,
      clientMinProtocol: Schema.String,
      clientMaxProtocol: Schema.String,
    }),
  },
) {
  static readonly message = "Client protocol version not supported";
}
```

Reason discriminant carried in `ProtocolMismatchError.data.reason`:
`server-above-client-max` — the server is newer than the client's
`maxProtocol`; the client must update. `server-below-client-min` — the
client is newer than the server supports.

## Files

- `connect.ts`
- `index.ts`
- `presence.ts`
