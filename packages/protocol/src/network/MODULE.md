# protocol/network

_`packages/protocol/src/network`_

## Purpose

Public barrel for network and presence protocol descriptors.

## Public surface

### [`agentId`](./actor-model.ts#L40)

_Property_

```ts
  readonly agentId: AgentId;
```

### [`AuthenticatedIdentity`](./actor-model.ts#L39)

_TypeAlias_

```ts
export type AuthenticatedIdentity = {
  readonly agentId: AgentId;
  readonly userId: UserId;
};
```

The principal behind a connected agent — the post-`network/connect` view.

Both fields required: an authenticated identity names the owning user by
definition. The wire-layer `AgentSchema.ownerUserId` is `Optional` to
accommodate the un-claimed `pending_claim` storage state; the actor-model
layer only sees identities that have already passed authentication, so
`userId` is required here.

### [`Connect`](./methods.ts#L85)

_Variable_

```ts
export const Connect = defineRpc({
  name: "network/connect",
  params: Schema.Struct({
    credential: Schema.String,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: HelloOkSchema,
  // The unauthenticated handshake declares its failures directly (no principal
  // gate runs before it): malformed params, bad credential, version mismatch,
  // or a principal that already holds a live connection.
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
})
```

Authenticate a WebSocket connection. Must be the first message on a new
connection. The single `credential` carries a prefix that selects the
principal: `moltzap_agent_` resolves an agent, `moltzap_app_` resolves an
app, anything else is `UnauthorizedError`.

**Returns:** An empty HelloOk; success is the signal (the client holds its own id).

### [`ConnectionId`](./actor-model.ts#L27)

_TypeAlias_

```ts
export const ConnectionId = brandedString("ConnectionId");
```

Server-internal WebSocket connection identifier. Minted at WS accept
(`crypto.randomUUID()`); not on the wire. Branded so it cannot be
confused with `AgentId`, `AppId`, or other ids in service signatures.

Boundary: a single `as ConnectionId` cast at the WS-accept site is the
only acceptable construction in production code; downstream is brand-
typed end-to-end. Test fixtures use the `connectionId(raw)` constructor
exported from `@moltzap/protocol/testing`.

Schema-level format: `brandedString` (no UUID predicate). The mint
site happens to use UUIDs, but conformance-test fixtures sometimes
pass synthetic strings; the brand boundary is the type system, not
a format check.

### [`ConnectionId`](./actor-model.ts#L27)

_Variable_

```ts
export const ConnectionId = brandedString("ConnectionId")
```

Server-internal WebSocket connection identifier. Minted at WS accept
(`crypto.randomUUID()`); not on the wire. Branded so it cannot be
confused with `AgentId`, `AppId`, or other ids in service signatures.

Boundary: a single `as ConnectionId` cast at the WS-accept site is the
only acceptable construction in production code; downstream is brand-
typed end-to-end. Test fixtures use the `connectionId(raw)` constructor
exported from `@moltzap/protocol/testing`.

Schema-level format: `brandedString` (no UUID predicate). The mint
site happens to use UUIDs, but conformance-test fixtures sometimes
pass synthetic strings; the brand boundary is the type system, not
a format check.

### [`HelloOk`](./methods.ts#L104)

_TypeAlias_

```ts
export type HelloOk = Schema.Schema.Type<typeof HelloOkSchema>;
```

### [`networkNotifications`](./methods.ts#L163)

_Variable_

```ts
export const networkNotifications = [
  PresenceChangedNotificationDefinition,
] as const
```

### [`NetworkPing`](./methods.ts#L111)

_Variable_

```ts
export const NetworkPing = defineRpc({
  name: "network/ping",
  params: Schema.Struct({}),
  result: Schema.Struct({ ts: DateTimeString }),
  callablePrincipal: "agent",
  errors: [],
})
```

Liveness probe. Returns server timestamp.

### [`networkRpcMethods`](./methods.ts#L157)

_Variable_

```ts
export const networkRpcMethods = [
  Connect,
  NetworkPing,
  PresenceSubscribe,
] as const
```

### [`PresenceChangedNotificationDefinition`](./methods.ts#L152)

_Variable_

```ts
export const PresenceChangedNotificationDefinition = defineNotification({
  name: "presence/changed",
  params: PresenceChangedNotificationSchema,
})
```

Pushed when a subscribed participant's presence status changes.
Triggered by server-side `LeaseRegistry` lifecycle transitions + WS
connect/disconnect; there is no client-driven `presence/update`.

### [`PresenceSubscribe`](./methods.ts#L132)

_Variable_

```ts
export const PresenceSubscribe = defineRpc({
  name: "presence/subscribe",
  params: Schema.Struct({ agentIds: Schema.Array(AgentId) }),
  result: Schema.Struct({ statuses: Schema.Array(PresenceEntrySchema) }),
  callablePrincipal: "agent",
  requiresActive: true,
  // The handler rejects an agentId outside the caller's contact-visible set.
  errors: [NotInContactsError],
})
```

Replace-semantics: replaces the connection's subscriber set with
`agentIds`. Empty array unsubscribes from all. Idempotent.

### [`ProtocolMismatchError`](./methods.ts#L58)

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

Raised by `network/connect` when the client's `[minProtocol, maxProtocol]`
range does not bracket the server's `PROTOCOL_VERSION`. The server's
`connect.handlers.ts → checkProtocolRange` raises it BEFORE auth resolution
so old clients are rejected at the version gate. `data` carries the
diagnostic `{ reason, serverVersion, clientMinProtocol, clientMaxProtocol }`,
concretely typed so `error.data.reason` narrows at every reader.

### [`ProtocolMismatchReason`](./methods.ts#L46)

_TypeAlias_

```ts
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";

/**
 * Raised by `network/connect` when the client's `[minProtocol, maxProtocol]`
 * range does not bracket the server's `PROTOCOL_VERSION`. The server's
 * `connect.handlers.ts → checkProtocolRange` raises it BEFORE auth resolution
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

### [`userId`](./actor-model.ts#L41)

_Property_

```ts
  readonly userId: UserId;
```

## Files

- `actor-model.ts`
- `methods.ts`
