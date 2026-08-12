# server-core/core

_`packages/server/src/core`_

## Purpose

Core service graph composition.

## Public surface

### [`ResolvedServices`](./index.ts#L58)

_Interface_

```ts
export interface ResolvedServices {
  readonly db: Db;
  readonly connections: ConnectionManager;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly conversationService: ConversationService;
  readonly messageService: MessageService;
}
```

Describes resolved services.

### [`resolveServices`](./index.ts#L69)

_Variable_

```ts
export const resolveServices = Effect.all({
  db: DbTag,
  connections: ConnectionManagerTag,
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  conversationService: ConversationServiceTag,
  messageService: MessageServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>
```

Provides the resolve services runtime value.

### [`servicesLive`](./index.ts#L52)

_Variable_

```ts
export const servicesLive = Layer.provideMerge(
  messageServiceLive,
  conversationWithNetworkLive,
)
```

Provides the services live runtime value.

## Files

- `index.ts`
