# protocol/network

_`packages/protocol/src/network`_

## Purpose

Public barrel for network and presence protocol descriptors.

## Public surface

### [`_ActorModelBarrelCanary`](./actor-model.types-check.ts#L11)

_TypeAlias_

```ts
export type _ActorModelBarrelCanary = _AuthenticatedIdentity;
```

### [`agentId`](./actor-model.ts#L41)

_Property_

```ts
  readonly agentId: AgentId;
```

### [`AuthenticatedIdentity`](./actor-model.ts#L40)

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
layer only sees identities that have already passed authentication, so the
optionality is collapsed here.

### [`Connect`](./methods.ts#L54)

_Variable_

```ts
export const Connect = defineRpc({
  name: "network/connect",
  params: Type.Union([
    Type.Object(
      {
        agentKey: Type.String(),
        minProtocol: Type.String(),
        maxProtocol: Type.String(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        sessionToken: Type.String(),
        minProtocol: Type.String(),
        maxProtocol: Type.String(),
      },
      { additionalProperties: false },
    ),
  ]),
  result: HelloOkSchema,
})
```

Authenticate a WebSocket connection. Must be the first message on a new connection.

**Returns:** Connection metadata including agent ID, protocol version, conversations, and server policy.

### [`ConnectionId`](./actor-model.ts#L28)

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

### [`ConnectionId`](./actor-model.ts#L28)

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

### [`HelloOk`](./methods.ts#L77)

_TypeAlias_

```ts
export type HelloOk = Static<typeof HelloOkSchema>;
```

### [`networkNotifications`](./methods.ts#L145)

_Variable_

```ts
export const networkNotifications = [
  PresenceChangedNotificationDefinition,
] as const
```

### [`NetworkPing`](./methods.ts#L84)

_Variable_

```ts
export const NetworkPing = defineRpc({
  name: "network/ping",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({ ts: DateTimeString }, { additionalProperties: false }),
})
```

Liveness probe. Returns server timestamp.

### [`networkRpcMethods`](./methods.ts#L138)

_Variable_

```ts
export const networkRpcMethods = [
  Connect,
  NetworkPing,
  PresenceUpdate,
  PresenceSubscribe,
] as const
```

### [`PresenceChangedNotificationDefinition`](./methods.ts#L133)

_Variable_

```ts
export const PresenceChangedNotificationDefinition = defineNotification({
  name: "presence/changed",
  params: PresenceChangedNotificationSchema,
})
```

Pushed when a subscribed participant's presence status changes.

### [`PresenceSubscribe`](./methods.ts#L109)

_Variable_

```ts
export const PresenceSubscribe = defineRpc({
  name: "presence/subscribe",
  params: Type.Object(
    { agentIds: Type.Array(AgentId) },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { statuses: Type.Array(PresenceEntrySchema) },
    { additionalProperties: false },
  ),
})
```

Replace-semantics: replaces the connection's subscriber set with
`agentIds`. Empty array unsubscribes from all. Idempotent.

### [`PresenceUpdate`](./methods.ts#L96)

_Variable_

```ts
export const PresenceUpdate = defineRpc({
  name: "presence/update",
  params: Type.Object(
    { status: PresenceStatusEnum },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
})
```

Update your presence status (online, offline, away).

### [`userId`](./actor-model.ts#L42)

_Property_

```ts
  readonly userId: UserId;
```

## Files

- `actor-model.ts`
- `actor-model.types-check.ts`
- `methods.ts`
