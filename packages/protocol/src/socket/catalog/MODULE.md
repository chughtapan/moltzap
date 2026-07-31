# protocol/socket/catalog

_`packages/protocol/src/socket/catalog`_

## Purpose

Closed RPC catalogs and Effect RPC groups for first-party socket wiring.

The main socket barrel exposes lifecycle classes. This module exposes the
derived method/notification catalogs and group types needed by client,
server-core, conformance, and generated protocol reference docs.

## Public surface

### [`agentCallableGroup`](./index.ts#L130)

_Variable_

```ts
export const agentCallableGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all agent-callable methods.

### [`agentCallableMethods`](./index.ts#L49)

_Variable_

```ts
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...agentCallableDispatchRpcMethods,
] as const
```

Client-to-server descriptors an agent principal may originate.

### [`AnyAgentCallableRpcDefinition`](./index.ts#L94)

_TypeAlias_

```ts
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];
```

Any descriptor an agent client may call.

### [`AnyAppCallableRpcDefinition`](./index.ts#L98)

_TypeAlias_

```ts
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];
```

Any descriptor an app client may call.

### [`AnyAppCallbackRpcDefinition`](./index.ts#L101)

_TypeAlias_

```ts
export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];
```

Any callback descriptor the server may call on an app client.

### [`AnyNotificationDefinition`](./index.ts#L104)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

Any server-to-client notification descriptor.

### [`AnyServerRpcDefinition`](./index.ts#L91)

_TypeAlias_

```ts
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];
```

Any client-to-server descriptor the server handles.

### [`appCallableGroup`](./index.ts#L135)

_Variable_

```ts
export const appCallableGroup = makeRpcGroup(
  appCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all app-callable methods.

### [`appCallableMethods`](./index.ts#L60)

_Variable_

```ts
export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const
```

Client-to-server descriptors an app principal may originate.

### [`appCallbackMethods`](./index.ts#L36)

_Variable_

```ts
export const appCallbackMethods = [
  ...dispatchCallbackMethods,
  ...messageCallbackMethods,
] as const
```

Server-to-app callback descriptors the app client must serve.

### [`notificationDefinitions`](./index.ts#L83)

_Variable_

```ts
export const notificationDefinitions = [
  ...networkNotifications,
  ...conversationNotifications,
  ...messageNotifications,
  ...dispatchNotifications,
] as const
```

Every server-to-client notification descriptor.

### [`notificationRpcGroup`](./index.ts#L145)

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

### [`reverseRpcGroup`](./index.ts#L160)

_Variable_

```ts
export const reverseRpcGroup = makeRpcGroup([
  ...appCallbackMethods.map((definition) => definition.clientRpc),
  ...notificationDefinitions.map((definition) => definition.notificationRpc),
])
```

The full server-to-client reverse group: the moderator callbacks
(`appCallbackMethods`) plus the notifications (notificationRpcGroup),
built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
awaiting a verdict, fires notifications fork-and-forget); the agent + app
clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
only ever receives notifications (its handlers for the three callback methods
are never invoked; an agent is not a moderator), but it serves the whole
group so the s2c engine binds one handler map.

### [`ServerHandler`](./index.ts#L126)

_TypeAlias_

```ts
export type ServerHandler<D extends AnyServerRpcDefinition> =
```

Handler type for one inbound RPC descriptor.

### [`ServerHandlers`](./index.ts#L121)

_TypeAlias_

```ts
export type ServerHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof serverInboundGroup>
>;
```

Complete server handler table keyed by every inbound RPC tag.

### [`serverInboundGroup`](./index.ts#L114)

_Variable_

```ts
export const serverInboundGroup = makeRpcGroup(
  serverInboundMethods.map((definition) => definition.serverRpc),
)
```

Effect RPC group for all client-to-server calls accepted by the server.

### [`serverInboundMethods`](./index.ts#L71)

_Variable_

```ts
export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...appOnlyCallableMethods,
  ...agentCallableDispatchRpcMethods,
] as const
```

Full server inbound descriptor union.

This is derived from the authored agent and app callable catalogs, with the
unauthenticated connect descriptors included once.

## Files

- `index.ts`
