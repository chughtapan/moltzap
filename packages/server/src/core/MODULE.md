# server-core/core

_`packages/server/src/core`_

## Purpose

Narrow core wiring barrel for server-core internals.

## Public surface

### [`CoreApp`](./types.ts#L5)

_Interface_

```ts
export interface CoreApp {
  readonly port: number;

  /**
   * Outbound-routing primitive. Apps emit events out-of-band via
   * `networkSendService.send(to, payload)` (directed) or
   * `networkSendService.broadcast(agentIds, payload, opts?)` (fan-out
   * across participants). Stable identity across the server lifetime.
   *
   * The backing `AgentEndpointResolver` is intentionally not exposed —
   * its mutable add/remove surface is server-internal lifecycle, not a
   * CoreApp consumer concern. Tests assert resolver state indirectly
   * via `networkSendService.send` outcomes.
   */
  readonly networkSendService: NetworkSendService;

  /**
   * Live ConnectionManager instance. Apps can query `getByParticipant` to
   * check whether an agent has any live connections (for liveness-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;
  close: () => PromiseLike<undefined>;
}
```

Describes core app.

### [`createCoreApp`](./app.ts#L94)

_Function_

```ts
export function createCoreApp(config: CoreConfig): CoreApp
```

Creates core app.

**Returns:** The created core app.

### [`ResolvedServices`](./layers.ts#L58)

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

### [`resolveServices`](./layers.ts#L69)

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

### [`ServerBootFailedError`](./app.ts#L34)

_Class_

```ts
export class ServerBootFailedError extends Data.TaggedError(
  "ServerBootFailedError",
)<{
  readonly phase: "http-listen";
  readonly cause: unknown;
}> {}
```

Typed fatal for boot failure. The `phase` discriminator names which boot step
failed: `"http-listen"` is `NodeHttpServer.make` / `serverSvc.serve`'s typed
`ServeError` (EADDRINUSE, EACCES, ...).

### [`servicesLive`](./layers.ts#L52)

_Variable_

```ts
export const servicesLive = Layer.provideMerge(
  messageServiceLive,
  conversationWithNetworkLive,
)
```

Provides the services live runtime value.

## Files

- `app.ts`
- `layers.ts`
- `types.ts`
