# protocol/socket/catalog

_`packages/protocol/src/socket/catalog`_

## Purpose

Closed RPC catalogs and Effect RPC groups for first-party socket wiring.

The main socket barrel exposes lifecycle classes. This module exposes the
derived method/notification catalogs and group types needed by client,
server-core, conformance, and generated protocol reference docs.

## Public surface

### [`agentCallableGroup`](./index.ts#L103)

_Variable_

```ts
export const agentCallableGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all agent-callable methods.

### [`agentCallableMethods`](./index.ts#L28)

_Variable_

```ts
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
] as const
```

Client-to-server descriptors an agent principal may originate.

### [`AnyAgentCallableRpcDefinition`](./index.ts#L70)

_TypeAlias_

```ts
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];
```

Any descriptor an agent client may call.

### [`AnyAppCallableRpcDefinition`](./index.ts#L74)

_TypeAlias_

```ts
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];
```

Any descriptor an app client may call.

### [`AnyNotificationDefinition`](./index.ts#L77)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

Any server-to-client notification descriptor.

### [`AnyServerRpcDefinition`](./index.ts#L67)

_TypeAlias_

```ts
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];
```

Any client-to-server descriptor the server handles.

### [`appCallableGroup`](./index.ts#L108)

_Variable_

```ts
export const appCallableGroup = makeRpcGroup(
  appCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all app-callable methods.

### [`appCallableMethods`](./index.ts#L38)

_Variable_

```ts
export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const
```

Client-to-server descriptors an app principal may originate.

### [`notificationDefinitions`](./index.ts#L60)

_Variable_

```ts
export const notificationDefinitions = [
  ...networkNotifications,
  ...conversationNotifications,
  ...messageNotifications,
] as const
```

Every server-to-client notification descriptor.

### [`notificationRpcGroup`](./index.ts#L118)

_Variable_

```ts
export const notificationRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
)
```

Server-to-client reverse notification group. The server fires each notification
as a fire-and-forget `void`-result RPC on a target connection's reverse
channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
each payload into the `SubscriberRegistry`.

### [`reverseRpcGroup`](./index.ts#L129)

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

### [`ServerHandler`](./index.ts#L99)

_TypeAlias_

```ts
export type ServerHandler<D extends AnyServerRpcDefinition> =
```

Handler type for one inbound RPC descriptor.

### [`ServerHandlers`](./index.ts#L94)

_TypeAlias_

```ts
export type ServerHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof serverInboundGroup>
>;
```

Complete server handler table keyed by every inbound RPC tag.

### [`serverInboundGroup`](./index.ts#L87)

_Variable_

```ts
export const serverInboundGroup = makeRpcGroup(
  serverInboundMethods.map((definition) => definition.serverRpc),
)
```

Effect RPC group for all client-to-server calls accepted by the server.

### [`serverInboundMethods`](./index.ts#L49)

_Variable_

```ts
export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...appOnlyCallableMethods,
] as const
```

Full server inbound descriptor union.

This is derived from the authored agent and app callable catalogs, with the
unauthenticated connect descriptors included once.

## Files

- `index.ts`
