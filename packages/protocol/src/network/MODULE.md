# protocol/network

_`packages/protocol/src/network`_

## Purpose

Public barrel for connect and presence protocol descriptors.

## Public surface

### [`agentCallableNetworkRpcMethods`](./index.ts#L31)

_Variable_

```ts
export const agentCallableNetworkRpcMethods = [
  agentConnect,
  agentPresenceSubscribe,
] as const
```

Network RPCs callable by agent clients.

### [`agentConnect`](./connect.ts#L194)

_Variable_

```ts
export const agentConnect = defineRpc({
  name: "agent/network/connect",
  params: Schema.Struct({
    agentKey: agentKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: helloOkSchema,
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

### [`agentPresenceSubscribe`](./presence.ts#L36)

_Variable_

```ts
export const agentPresenceSubscribe = defineRpc({
  name: "agent/network/presence/subscribe",
  params: presenceSubscribeParamsSchema,
  result: presenceSubscribeResultSchema,
  requires: [AgentPrincipal],
  errors: [NotInContactsError],
})
```

Defines the `agent/network/presence/subscribe` RPC contract.

### [`appCallableNetworkRpcMethods`](./index.ts#L37)

_Variable_

```ts
export const appCallableNetworkRpcMethods = [
  appConnect,
  appPresenceSubscribe,
] as const
```

Network RPCs callable by app clients.

### [`appConnect`](./connect.ts#L226)

_Variable_

```ts
export const appConnect = defineRpc({
  name: "app/network/connect",
  params: Schema.Struct({
    appKey: appKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: helloOkSchema,
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

### [`appPresenceSubscribe`](./presence.ts#L45)

_Variable_

```ts
export const appPresenceSubscribe = defineRpc({
  name: "app/network/presence/subscribe",
  params: presenceSubscribeParamsSchema,
  result: presenceSubscribeResultSchema,
  requires: [AppPrincipal],
  errors: [],
})
```

Defines the `app/network/presence/subscribe` RPC contract.

### [`checkProtocolRange`](./connect.ts#L120)

_Function_

```ts
export function checkProtocolRange(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  serverVersion: string,
): Effect.Effect<void, ProtocolMismatchError | InvalidProtocolVersionError>
```

Executes the check protocol range operation.

**Returns:** The check protocol range result.

### [`compareProtocolVersion`](./connect.ts#L95)

_Function_

```ts
export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1
```

Executes the compare protocol version operation.

**Returns:** The compare protocol version result.

### [`HelloOk`](./connect.ts#L28)

_TypeAlias_

```ts
export type HelloOk = Schema.Schema.Type<typeof helloOkSchema>;
```

Represents hello ok values.

### [`InvalidProtocolVersionError`](./connect.ts#L67)

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

Reports invalid protocol version failures.

### [`networkNotifications`](./index.ts#L51)

_Variable_

```ts
export const networkNotifications = [] as const
```

Network notifications emitted by the server.

### [`networkRpcMethods`](./index.ts#L43)

_Variable_

```ts
export const networkRpcMethods = [
  agentConnect,
  appConnect,
  agentPresenceSubscribe,
  appPresenceSubscribe,
] as const
```

Network RPCs accepted by the server.

### [`PROTOCOL_VERSION`](./connect.ts#L13)

_Variable_

```ts
export const PROTOCOL_VERSION = packageJson.version
```

The published package version is also the wire-protocol version.

### [`ProtocolMismatchError`](./connect.ts#L48)

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

### [`ProtocolMismatchReason`](./connect.ts#L36)

_TypeAlias_

```ts
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";
```

Reason discriminant carried in `ProtocolMismatchError.data.reason`:
`server-above-client-max` — the server is newer than the client's
`maxProtocol`; the client must update. `server-below-client-min` — the
client is newer than the server supports.

### [`serverBaseUrl`](./server-url.ts#L105)

_Variable_

```ts
export const serverBaseUrl = Schema.decodeSync(serverBaseUrlSchema)
```

Throwing constructor for addresses a caller already knows are well-formed,
such as one a locally started server just reported. Decode with
`Schema.decodeEither(ServerBaseUrl)` wherever the value comes from
configuration or another package.

### [`ServerBaseUrl`](./server-url.ts#L68)

_TypeAlias_

```ts
export type ServerBaseUrl = string & Brand.Brand<"ServerBaseUrl">;
```

A MoltZap server address carrying no path, query, or fragment, over
`http`, `https`, `ws`, or `wss`.

### [`serverBaseUrlSchema`](./server-url.ts#L74)

_Variable_

```ts
export const serverBaseUrlSchema: Schema.Schema<ServerBaseUrl, string> =
  Schema.transformOrFail(
    Schema.String,
    Schema.String.pipe(Schema.brand("ServerBaseUrl")),
    {
      strict: true,
      decode: (value, options, ast) => {
        void options;
        const origin = toOrigin(value);
        return origin === null
          ? ParseResult.fail(
              new ParseResult.Type(
                ast,
                value,
                `Expected a MoltZap server base URL (scheme and host, no path), got ${JSON.stringify(value)}`,
              ),
            )
          : ParseResult.succeed(origin);
      },
      encode: ParseResult.succeed,
    },
  ).pipe(
    Schema.annotations({ description: "Path-free MoltZap server base URL" }),
  )
```

Decodes either address a caller is likely to hold — the base URL or the
socket endpoint — into the path-free base. Any other path fails.

### [`webSocketUrl`](./server-url.ts#L112)

_Function_

```ts
export const webSocketUrl = (base: ServerBaseUrl): string
```

The socket endpoint a client dials for the given server.

**Returns:** The web socket url result.

## Files

- `connect.ts`
- `index.ts`
- `presence.ts`
- `server-url.ts`
