# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, and contact protocol descriptors.

## Public surface

### [`identityNotifications`](./index.ts#L103)

_Variable_

```ts
export const identityNotifications = [
  contactRequestNotificationDefinition,
  contactAcceptedNotificationDefinition,
] as const
```

Identity notification catalog emitted by the server.

### [`identityRpcMethods`](./index.ts#L95)

_Variable_

```ts
export const identityRpcMethods = [
  agentsList,
  contactsList,
  contactsAdd,
  contactsAccept,
] as const
```

Identity RPC catalog accepted by agent clients.

## Files

- `index.ts`
