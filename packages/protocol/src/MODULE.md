# protocol/src

_`packages/protocol/src`_

## Purpose

Protocol package root.

The root surface is intentionally tiny: concrete protocol-owned socket
lifecycle classes only. Domain descriptors, schemas, requirement tags, and
testing helpers live behind focused package subpaths.

## Public surface

### [`AgentCallableGroup`](./rpc-method-groups.ts#L105)

_Variable_

```ts
export const AgentCallableGroup = makeClientRpcGroup(agentCallableMethods)
```

### [`agentCallableMethods`](./rpc-method-groups.ts#L55)

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

### [`AgentKey`](./credentials.ts#L35)

_TypeAlias_

```ts
export type AgentKey = Redacted.Redacted<AgentKeyValue>;
```

### [`AgentKey`](./credentials.ts#L35)

_Variable_

```ts
export type AgentKey = Redacted.Redacted<AgentKeyValue>
```

### [`AnyAgentCallableRpcDefinition`](./rpc-method-groups.ts#L89)

_TypeAlias_

```ts
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];
```

### [`AnyAppCallableRpcDefinition`](./rpc-method-groups.ts#L91)

_TypeAlias_

```ts
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];
```

### [`AnyAppCallbackRpcDefinition`](./rpc-method-groups.ts#L93)

_TypeAlias_

```ts
export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];
```

### [`AnyNotificationDefinition`](./rpc-method-groups.ts#L95)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

### [`AnyServerRpcDefinition`](./rpc-method-groups.ts#L88)

_TypeAlias_

```ts
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];
```

### [`AppCallableGroup`](./rpc-method-groups.ts#L107)

_Variable_

```ts
export const AppCallableGroup = makeClientRpcGroup(appCallableMethods)
```

### [`appCallableMethods`](./rpc-method-groups.ts#L64)

_Variable_

```ts
export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const
```

### [`appCallbackMethods`](./rpc-method-groups.ts#L35)

_Variable_

```ts
export const appCallbackMethods = [
  ...dispatchCallbackMethods,
  ...messageCallbackMethods,
  ...taskCallbackMethods,
] as const
```

### [`AppKey`](./credentials.ts#L39)

_TypeAlias_

```ts
export type AppKey = Redacted.Redacted<AppKeyValue>;
```

### [`AppKey`](./credentials.ts#L39)

_Variable_

```ts
export type AppKey = Redacted.Redacted<AppKeyValue>
```

### [`CapabilityRequirement`](./requirements.ts#L34)

_TypeAlias_

```ts
export type CapabilityRequirement =
  | typeof ConversationInTask
  | typeof ConversationSendAccess
  | typeof TaskReadAccess
  | typeof ContactPolicyAllowsReach;

export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
 * The descriptor order is logical run order. `@effect/rpc` runs the last
 * attached middleware first, so the engine attaches the reverse order.
 */
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement> => {
  const stack: Requirement[] = [];
  const seen = new Set<Requirement>();
  for (const requirement of requires) {
    if (!seen.has(requirement)) {
      seen.add(requirement);
      stack.push(requirement);
    }
  }
  return stack.reverse();
};
```

### [`InviteCode`](./credentials.ts#L51)

_TypeAlias_

```ts
export type InviteCode = Redacted.Redacted<InviteCodeValue>;
```

### [`InviteCode`](./credentials.ts#L51)

_Variable_

```ts
export type InviteCode = Redacted.Redacted<InviteCodeValue>
```

### [`middlewaresForRequirements`](./requirements.ts#L50)

_Function_

```ts
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement>
```

The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
The descriptor order is logical run order. `@effect/rpc` runs the last
attached middleware first, so the engine attaches the reverse order.

### [`MwStackFor`](./requirements.ts#L64)

_TypeAlias_

```ts
export type MwStackFor<Requires extends ReadonlyArray<unknown>> = Extract<
  Requires[number],
  Requirement
>;
```

### [`notificationDefinitions`](./rpc-method-groups.ts#L79)

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

### [`NotificationRpcGroup`](./rpc-method-groups.ts#L150)

_Variable_

```ts
export const NotificationRpcGroup = makeNotificationRpcGroup(
  notificationDefinitions,
)
```

Server→client reverse notification group. The server fires each notification
as a fire-and-forget `void`-result RPC on a target connection's reverse
channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
each payload into the `SubscriberRegistry`. Reuses the same s2c reverse-RPC
machinery as the moderator callbacks folded into ReverseRpcGroup.

### [`Principal`](./requirements.ts#L30)

_TypeAlias_

```ts
export type Principal =
  | { readonly _tag: "AgentContext"; readonly agentId: AgentId }
```

The authenticated principal of the in-flight request. The server's
`AgentContext` / `AppContext` structurally inhabit this union, so the server
can return the live narrowed arm directly from the principal gate.

### [`principalRequirementOf`](./requirements.ts#L69)

_Function_

```ts
export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined
```

### [`PrincipalRequirementOf`](./requirements.ts#L80)

_TypeAlias_

```ts
export type PrincipalRequirementOf<
  Requires extends ReadonlyArray<Requirement>,
> = Requires extends readonly [infer Head, ...ReadonlyArray<unknown>]
```

### [`RegistrationSecret`](./credentials.ts#L77)

_TypeAlias_

```ts
export type RegistrationSecret = Redacted.Redacted<RegistrationSecretValue>;
```

### [`RegistrationSecret`](./credentials.ts#L77)

_Variable_

```ts
export type RegistrationSecret = Redacted.Redacted<RegistrationSecretValue>
```

### [`Requirement`](./requirements.ts#L40)

_TypeAlias_

```ts
export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
 * The descriptor order is logical run order. `@effect/rpc` runs the last
 * attached middleware first, so the engine attaches the reverse order.
 */
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement> => {
  const stack: Requirement[] = [];
  const seen = new Set<Requirement>();
  for (const requirement of requires) {
    if (!seen.has(requirement)) {
      seen.add(requirement);
      stack.push(requirement);
    }
  }
  return stack.reverse();
};
```

### [`requiresClaimed`](./requirements.ts#L88)

_Function_

```ts
export const requiresClaimed = (
  requires: ReadonlyArray<Requirement>,
): boolean
```

### [`ReverseRpcGroup`](./rpc-method-groups.ts#L165)

_Variable_

```ts
export const ReverseRpcGroup = makeReverseRpcGroup(
  appCallbackMethods,
  notificationDefinitions,
)
```

The full server→client reverse group: the moderator callbacks
(`appCallbackMethods`) ∪ the notifications (NotificationRpcGroup),
built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
awaiting a verdict, fires notifications fork-and-forget); the agent + app
clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
only ever receives notifications (its handlers for the three callback methods
are never invoked — an agent is not a moderator), but it serves the whole
group so the s2c engine binds one handler map.

### [`ServerEncryptionMasterSecret`](./credentials.ts#L81)

_TypeAlias_

```ts
export type ServerEncryptionMasterSecret =
  Redacted.Redacted<ServerEncryptionMasterSecretValue>;
```

### [`ServerEncryptionMasterSecret`](./credentials.ts#L81)

_Variable_

```ts
export type ServerEncryptionMasterSecret =
  Redacted.Redacted<ServerEncryptionMasterSecretValue>
```

### [`serverInboundMethods`](./rpc-method-groups.ts#L69)

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

## Files

- `credentials.ts`
- `requirements.ts`
- `rpc-method-groups.ts`
