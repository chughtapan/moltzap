# protocol/socket/catalog

_`packages/protocol/src/socket/catalog`_

## Purpose

Closed RPC catalogs and Effect RPC groups for first-party socket wiring.

The main socket barrel exposes lifecycle classes. This module exposes the
derived method/notification catalogs and group types needed by client and
server-core.

## Public surface

### [`agentCallableGroup`](./index.ts#L61)

_Variable_

```ts
export const agentCallableGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all agent-callable methods.

### [`AnyNotificationDefinition`](./index.ts#L35)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

Any server-to-client notification descriptor.

### [`reverseRpcGroup`](./index.ts#L72)

_Variable_

```ts
export const reverseRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
)
```

The full server-to-client reverse group: every notification descriptor,
built as ONE `RpcGroup` over the member tuple. The server holds one
`RpcClient&lt;ReverseRpcGroup>` per connection (fires notifications
fork-and-forget); clients stand one `RpcServer&lt;ReverseRpcGroup>` on the
s2c sink, routing each payload into the `SubscriberRegistry`.

### [`ServerHandler`](./index.ts#L57)

_TypeAlias_

```ts
export type ServerHandler<D extends AnyServerRpcDefinition> =
```

Handler type for one inbound RPC descriptor.

### [`ServerHandlers`](./index.ts#L52)

_TypeAlias_

```ts
export type ServerHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof serverInboundGroup>
>;
```

Complete server handler table keyed by every inbound RPC tag.

### [`serverInboundGroup`](./index.ts#L45)

_Variable_

```ts
export const serverInboundGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.serverRpc),
)
```

Effect RPC group for all client-to-server calls accepted by the server.

## Files

- `index.ts`
