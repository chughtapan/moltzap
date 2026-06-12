# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, and contact protocol descriptors.

## Public surface

### [`identityNotifications`](./index.ts#L68)

_Variable_

```ts
export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const
```

Identity notification catalog emitted by the server.

### [`identityRpcMethods`](./index.ts#L60)

_Variable_

```ts
export const identityRpcMethods = [
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
] as const
```

Identity RPC catalog accepted by agent clients.

## Files

- `index.ts`
