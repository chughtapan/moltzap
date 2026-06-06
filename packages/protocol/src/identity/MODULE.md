# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, and contact protocol descriptors.

## Public surface

### [`identityNotifications`](./methods.ts#L24)

_Variable_

```ts
export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const
```

### [`identityRpcMethods`](./methods.ts#L14)

_Variable_

```ts
export const identityRpcMethods = [
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
] as const
```

## Files

- `methods.ts`
