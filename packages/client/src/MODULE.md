# client/src

_`packages/client/src`_

## Purpose

Public barrel for the MoltZap client package.

## Public surface

### [`acquireHarnessClient`](./harness-client.ts#L196)

_Function_

```ts
export const acquireHarnessClient = (
  options: HarnessClientOptions,
): Effect.Effect<
  HarnessClientService,
  Error,
  Scope.Scope | KeyValueStore.KeyValueStore
>
```

Acquires one turn-ready harness connection and receive stream for the
lifetime of the enclosing scope. The supplied KeyValueStore is local to the
active agent and holds only stable presentation checkpoints.

**Returns:** The scoped adapter-facing service value.

### [`acquireMoltzapdChild`](./moltzapd-child.ts#L209)

_Function_

```ts
export const acquireMoltzapdChild = (
  options: MoltzapdChildOptions,
): Effect.Effect<MoltzapdChild, MoltzapdChildError, Scope.Scope>
```

Starts the package's real `moltzapd` binary against an existing slot.
The slot carries the loopback port, so the child receives only its profile
name and the returned URL is derived from the same persisted value.

**Returns:** A scoped packaged daemon after its MCP status reports connected.

### [`AgentClientOptions`](./../../protocol/dist/socket/agent-client.d.ts#L13)

_Interface_

```ts
export interface AgentClientOptions {
    readonly serverUrl: string;
    readonly agentKey: AgentKey;
    readonly onDisconnect?: (close: CloseInfo) => void;
}
```

Configures agent client.

### [`ContextOptions`](./service.ts#L89)

_Interface_

```ts
export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}
```

Configures context.

### [`ConversationMeta`](./presentation/state.ts#L25)

_Interface_

```ts
export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}
```

Describes conversation meta.

### [`ConversationWithParticipants`](./harness/runtime.ts#L138)

_TypeAlias_

```ts
export type ConversationWithParticipants = Schema.Schema.Type<
  typeof conversationWithParticipantsSchema
>;
```

Conversation plus its membership, assembled by the daemon because the
canonical Conversation sent over the network carries no participants. It
crosses only the loopback MCP boundary, and it is public because it names
what `HarnessClientService.startConversation` hands back to an adapter.

### [`HarnessClient`](./harness-client.ts#L58)

_Class_

```ts
export class HarnessClient extends Context.Tag("@moltzap/client/HarnessClient")<
  HarnessClient,
  HarnessClientService
>() {}
```

Effect service tag consumed by runtime adapters.

### [`harnessClientForProfile`](./moltzapd-child.ts#L250)

_Function_

```ts
export const harnessClientForProfile = (
  profileName: string,
): Effect.Effect<
  HarnessClientService,
  MoltzapdChildError | Error,
  Scope.Scope
>
```

Acquire the adapter-facing client for one named profile slot.

This is the whole production composition: the slot's own daemon child, the
loopback endpoint derived from the slot, and a file-backed checkpoint store.
A caller supplies only the profile name — no URL, no port, no store.

The checkpoint directory is keyed by profile name rather than AgentId,
because the store must be provided before `acquireHarnessClient` reads the
identity from the daemon's status tool. One slot is exactly one AgentId, so
the profile name is a stable agent scope.

**Returns:** The scoped adapter-facing service value.

### [`HarnessClientOptions`](./harness-client.ts#L64)

_Interface_

```ts
export interface HarnessClientOptions {
  /** Loopback `POST /mcp` endpoint owned by one running `moltzapd`. */
  readonly url: string;
}
```

Inputs needed to connect one scoped harness client.

### [`HarnessClientService`](./harness-client.ts#L45)

_Interface_

```ts
export interface HarnessClientService {
  /** Active identity used by adapters when rendering self-authored context. */
  readonly agentId: AgentId;
  /** Creates a conversation with named peers and sends its initial content. */
  readonly startConversation: (
    otherAgentNames: readonly AgentName[],
    initialContent: string,
  ) => Effect.Effect<ConversationWithParticipants, Error>;
  /** The sole receive stream owned by this scoped client. */
  readonly turns: Stream.Stream<HarnessTurn, Error>;
}
```

Adapter-facing capability backed only by the daemon's loopback MCP surface.

### [`HarnessTurn`](./harness-client.ts#L39)

_Interface_

```ts
export interface HarnessTurn extends EnrichedInboundMessage {
  /** Sends model output through the MCP reply route captured by this turn. */
  readonly reply: (payload: string) => Effect.Effect<void, Error>;
}
```

Existing adapter presentation with reply authority bound to its live turn.

### [`makeHarnessClientLayer`](./harness-client.ts#L227)

_Function_

```ts
export const makeHarnessClientLayer = (
  options: HarnessClientOptions,
): Layer.Layer<HarnessClient, Error, KeyValueStore.KeyValueStore>
```

Builds the scoped runtime-adapter layer for one daemon endpoint.

**Returns:** A Layer providing the scoped HarnessClient capability.

### [`MoltZapAgentClient`](./../../protocol/dist/socket/agent-client.d.ts#L19)

_Class_

```ts
export declare class MoltZapAgentClient extends ProtocolClientLifecycle<AgentCallableRpcs, AgentClientDispatch> {
    constructor(options: AgentClientOptions);
    call<Tag extends AgentCallableTag>(tag: Tag, payload: PayloadForTag<AgentCallableRpcs, Tag>, opts?: RpcCallOptions): Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, ErrorForTag<AgentCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError>;
}
```

Implements molt zap agent client.

### [`MoltzapdChild`](./moltzapd-child.ts#L39)

_Interface_

```ts
export interface MoltzapdChild {
  readonly mcpUrl: string;
  readonly logs: () => string;
}
```

Explicit endpoint for a packaged daemon owned by the enclosing test scope.

### [`MoltzapdChildOptions`](./moltzapd-child.ts#L45)

_Interface_

```ts
export interface MoltzapdChildOptions {
  readonly profileName: string;
}
```

Inputs for starting the packaged daemon against caller-scoped test config.

### [`MoltZapService`](./service.ts#L196)

_Class_

```ts
export class MoltZapService {
  private client: MoltZapAgentClient | null = null;
  private connectedValue = false;
  private shutdownCompletion: Deferred.Deferred<undefined> | null = null;

  /**
   * Service-owned scope. Opened in `connect()`, owns the
   * `subscribeAll → Stream.runForEach` fan-out fiber. Closed in `close()` so
   * the fiber terminates with the service.
   *
   * Held off the public `connect()` signature so callers do not need to
   * thread a `Scope` requirement.
   */
  private serviceScope: Scope.CloseableScope | null = null;

  private readonly presentationState = new PresentationState();

  /**
   * The branded outer and inner keys keep conversation and message ids from
   * crossing accidentally while each conversation owns its eviction window.
   */
  private readonly seenMessageIds = new Map<
    ConversationId,
    BoundedMap<MessageId, true>
  >();
  private readonly handlers: {
    [K in ServiceHandlerName]: Array<
      NotificationHandler<ServiceHandlerPayloads[K]>
    >;
  } = {
    message: [],
    rawNotification: [],
    disconnect: [],
  };

  private readonly ownAgentIdValue: AgentId;

  private readonly opts: ServiceOptions;

  protected constructor(opts: ServiceOptions) {
    this.opts = opts;
    // The empty HelloOk carries no identity; `ownAgentId` is the client's
    // registered/stored id, available before the handshake.
    this.ownAgentIdValue = opts.agentId;
  }

  static fromConfig(config: MoltzapServiceConfig): MoltZapService {
    return new MoltZapService(config);
  }

  static make(
    profileName: string,
  ): Effect.Effect<MoltZapService, ServiceConfigError> {
    return loadServiceConfig(profileName).pipe(
      Effect.map((config) => MoltZapService.fromConfig(config)),
    );
  }

  get connected(): boolean {
    return this.connectedValue;
  }

  get ownAgentId(): AgentId | undefined {
    return this.ownAgentIdValue;
  }

  /**
   * Effect-native: compose via `yield*` or bridge at the edge via `Effect.runPromise`.
   * @returns The client result.
   */
  connect(): Effect.Effect<HelloOk, ServiceRpcError> {
    return Effect.gen(
      function* (this: MoltZapService) {
        // A new connection never takes ownership while resources from the
        // preceding lifecycle are still closing.
        while (this.shutdownCompletion !== null) {
          const priorShutdown = this.shutdownCompletion;
          yield* Deferred.await(priorShutdown);
          if (this.shutdownCompletion === priorShutdown) {
            this.shutdownCompletion = null;
          }
        }
        const client = new MoltZapAgentClient({
          serverUrl: this.opts.serverUrl,
          agentKey: this.opts.agentKey,
          // The body doesn't branch on close metadata today; the signature is
          // kept explicit so a future disconnect-handler chain can plumb
          // code/reason through.
          onDisconnect: () => {
            this.connectedValue = false;
            fanout(this.handlers.disconnect, undefined);
          },
        });
        this.client = client;

        // `subscribeAll().pipe(Stream.runForEach, …)` is forked into a
        // service-owned scope. The Stream is materialized BEFORE `connect()` so
        // subscriptions are registered with the registry pre-handshake (a
        // pre-connect-legal operation).
        //
        // Stream errors of type `NotConnectedError` are surfaced on the
        // fiber's failure channel only when the client transitions to
        // terminal closed state (close() path); `Effect.catchAll` here
        // would swallow them silently, so we route through `Effect.logError`
        // before the fiber exits.
        const serviceScope = yield* Scope.make();
        this.serviceScope = serviceScope;
        const fanoutEffect = client.subscribeAll().pipe(
          Stream.runForEach((notification) =>
            Effect.sync(() => {
              this.handleNotification(notification);
            }),
          ),
          Effect.catchAll((cause) =>
            Effect.logWarning(
              "MoltZapService notification fan-out terminated",
              cause,
            ),
          ),
          Effect.asVoid,
```

Stateful MoltZap client that manages connection, conversation tracking,
agent name resolution, and cross-conversation context generation.

API contract: **every fallible method returns `Effect`.** No `*Async`
Promise siblings — async/await consumers run the Effect at the edge
with `Effect.runPromise`. Keep this class Effect-only so downstream
callers compose failures and cancellation explicitly.

### [`RpcCallOptions`](./../../protocol/dist/socket/lifecycle.d.ts#L12)

_Interface_

```ts
export interface RpcCallOptions {
    readonly timeoutMs?: number;
}
```

Configures rpc call.

### [`ServiceRpcError`](./service.ts#L83)

_TypeAlias_

```ts
export type ServiceRpcError =
  | Rpc.Error<AgentCallableRpcs>
```

Errors that can surface from the Effect-based service API: any tagged error
an agent-callable method declares (recovered from the group's per-method
error unions) plus the transport errors. A method that fans several calls
surfaces this broad union; a single-method call narrows to that method's
errors at the `call` site.

## Files

- `harness-client.ts`
- `runtime.ts`
- `moltzapd-child.ts`
- `state.ts`
- `service.ts`
