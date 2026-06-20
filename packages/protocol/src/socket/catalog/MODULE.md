# protocol/socket/catalog

_`packages/protocol/src/socket/catalog`_

## Purpose

Closed RPC catalogs and Effect RPC groups for first-party socket wiring.

The main socket barrel exposes lifecycle classes. This module exposes the
derived method/notification catalogs and group types needed by client,
server-core, conformance, and generated protocol reference docs.

## Public surface

### [`AgentCallableGroup`](./index.ts#L142)

_Variable_

```ts
export const AgentCallableGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all agent-callable methods.

### [`agentCallableMethods`](./index.ts#L57)

_Variable_

```ts
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...agentCallableDispatchRpcMethods,
] as const
```

Client-to-server descriptors an agent principal may originate.

### [`AnyAgentCallableRpcDefinition`](./index.ts#L106)

_TypeAlias_

```ts
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];
```

Any descriptor an agent client may call.

### [`AnyAppCallableRpcDefinition`](./index.ts#L110)

_TypeAlias_

```ts
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];
```

Any descriptor an app client may call.

### [`AnyAppCallbackRpcDefinition`](./index.ts#L113)

_TypeAlias_

```ts
export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];
```

Any callback descriptor the server may call on an app client.

### [`AnyNotificationDefinition`](./index.ts#L116)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

Any server-to-client notification descriptor.

### [`AnyServerRpcDefinition`](./index.ts#L103)

_TypeAlias_

```ts
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];
```

Any client-to-server descriptor the server handles.

### [`AppCallableGroup`](./index.ts#L147)

_Variable_

```ts
export const AppCallableGroup = makeRpcGroup(
  appCallableMethods.map((definition) => definition.clientRpc),
)
```

Effect RPC group for all app-callable methods.

### [`appCallableMethods`](./index.ts#L69)

_Variable_

```ts
export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const
```

Client-to-server descriptors an app principal may originate.

### [`appCallbackMethods`](./index.ts#L42)

_Variable_

```ts
export const appCallbackMethods = [
  ...dispatchCallbackMethods,
  ...messageCallbackMethods,
  ...taskCallbackMethods,
] as const
```

Server-to-app callback descriptors the app client must serve.

### [`notificationDefinitions`](./index.ts#L93)

_Variable_

```ts
export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...conversationNotifications,
  ...messageNotifications,
  ...dispatchNotifications,
] as const
```

Every server-to-client notification descriptor.

### [`NotificationRpcGroup`](./index.ts#L157)

_Variable_

```ts
export const NotificationRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
)
```

Server-to-client reverse notification group. The server fires each notification
as a fire-and-forget `void`-result RPC on a target connection's reverse
channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
each payload into the `SubscriberRegistry`.

### [`ReverseRpcGroup`](./index.ts#L172)

_Variable_

```ts
export const ReverseRpcGroup = makeRpcGroup([
  ...appCallbackMethods.map((definition) => definition.clientRpc),
  ...notificationDefinitions.map((definition) => definition.notificationRpc),
])
```

The full server-to-client reverse group: the moderator callbacks
(`appCallbackMethods`) plus the notifications (NotificationRpcGroup),
built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
awaiting a verdict, fires notifications fork-and-forget); the agent + app
clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
only ever receives notifications (its handlers for the three callback methods
are never invoked; an agent is not a moderator), but it serves the whole
group so the s2c engine binds one handler map.

### [`ServerHandler`](./index.ts#L138)

_TypeAlias_

```ts
export type ServerHandler<D extends AnyServerRpcDefinition> =
```

Handler type for one inbound RPC descriptor.

### [`ServerHandlers`](./index.ts#L133)

_TypeAlias_

```ts
export type ServerHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof ServerInboundGroup>
>;
```

Complete server handler table keyed by every inbound RPC tag.

### [`ServerInboundGroup`](./index.ts#L126)

_Variable_

```ts
export const ServerInboundGroup = makeRpcGroup(
  serverInboundMethods.map((definition) => definition.serverRpc),
)
```

Effect RPC group for all client-to-server calls accepted by the server.

### [`serverInboundMethods`](./index.ts#L80)

_Variable_

```ts
export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableTaskRpcMethods,
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
