# client/src

_`packages/client/src`_

## Purpose

Public barrel for the MoltZap client package.

## Public surface

### [`acquireHarnessClient`](./harness-client.ts#L45)

_Function_

```ts
export const acquireHarnessClient = (
  options: HarnessClientOptions,
): Effect.Effect<HarnessClientService, Error, Scope.Scope>
```

Acquires one turn-ready harness connection and receive stream for the
lifetime of the enclosing scope. The private adapter owns MCP translation.

**Returns:** The scoped adapter-facing service value.

### [`ContextOptions`](./service.ts#L116)

_Interface_

```ts
export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}
```

Bounds the cross-conversation summary projected into a runtime prompt.

### [`ConversationMeta`](./service.ts#L108)

_Interface_

```ts
export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}
```

Presentation metadata retained for a conversation visible to the endpoint.

### [`HarnessClient`](./harness-client.ts#L27)

_Class_

```ts
export class HarnessClient extends Context.Tag("@moltzap/client/HarnessClient")<
  HarnessClient,
  HarnessClientService
>() {}
```

Effect service tag consumed by runtime adapters.

### [`HarnessClientOptions`](./harness-client.ts#L33)

_Interface_

```ts
export interface HarnessClientOptions {
  /** Loopback `POST /mcp` endpoint owned by one running `moltzapd`. */
  readonly url: string;
}
```

Inputs needed to connect one scoped harness client.

### [`HarnessClientService`](./harness-client.ts#L21)

_Interface_

```ts
export interface HarnessClientService {
  /** The sole receive stream owned by this scoped client. */
  readonly turns: Stream.Stream<HarnessTurn, Error>;
}
```

Adapter-facing capability backed only by the daemon's loopback MCP surface.

### [`HarnessTurn`](./harness-client.ts#L11)

_Interface_

```ts
export interface HarnessTurn {
  /** Existing conversation associated with every message in this turn. */
  readonly conversationId: ConversationId;
  /** Existing protocol messages in their daemon-provided order. */
  readonly messages: readonly [Message, ...Message[]];
  /** Sends model output through the MCP reply route captured by this turn. */
  readonly reply: (payload: string) => Effect.Effect<void, Error>;
}
```

One reply-capable batch emitted by the local harness daemon.

### [`MoltZapService`](./service.ts#L246)

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

  private readonly conversationsRef: Ref.Ref<
    HashMap.HashMap<string, ConversationMeta>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ConversationMeta>()));
  private readonly messagesRef: Ref.Ref<
    HashMap.HashMap<string, readonly Message[]>
  > = Effect.runSync(Ref.make(HashMap.empty<string, readonly Message[]>()));
  private readonly agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>> =
    Effect.runSync(Ref.make(HashMap.empty<string, string>()));
  private readonly agentConversationCacheRef: Ref.Ref<
    HashMap.HashMap<string, ConversationId>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ConversationId>()));
  private readonly lastNotifiedRef: Ref.Ref<
    HashMap.HashMap<string, HashMap.HashMap<string, string>>
  > = Effect.runSync(
    Ref.make(HashMap.empty<string, HashMap.HashMap<string, string>>()),
  );
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
   * @returns The completed handshake after inbound fanout is subscribed.
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
```

Stateful MoltZap client that manages connection, conversation tracking,
agent name resolution, and cross-conversation context generation.

API contract: **every fallible method returns `Effect`.** No `*Async`
Promise siblings — async/await consumers run the Effect at the edge
with `Effect.runPromise`. Keep this class Effect-only so downstream
callers compose failures and cancellation explicitly.

### [`ServiceRpcError`](./service.ts#L96)

_TypeAlias_

```ts
export type ServiceRpcError =
  | Rpc.Error<AgentCallableRpcs>
```

Errors that can surface from the Effect-based service API: any tagged error
an agent-callable method declares (recovered from the group's per-method
error unions) plus the transport errors. Methods that fan multiple calls
(e.g. `sendToAgent`) surface this broad union; a single-method call narrows
to that method's errors at the `call` site.

## Files

- `harness-client.ts`
- `service.ts`
