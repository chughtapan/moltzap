# protocol/runtime

_`packages/protocol/src/runtime`_

## Purpose

Runtime connection identifiers shared by protocol socket lifecycle.

## Public surface

### [`connectionId`](./connection.ts#L22)

_Variable_

```ts
export const connectionId = Schema.decodeSync(ConnectionId)
```

### [`ConnectionId`](./connection.ts#L19)

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

### [`ConnectionId`](./connection.ts#L19)

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

### [`newConnectionId`](./connection.ts#L24)

_Function_

```ts
export const newConnectionId = (): ConnectionId
```

## Files

- `connection.ts`
