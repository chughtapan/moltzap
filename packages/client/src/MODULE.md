# client/src

_`packages/client/src`_

## Purpose

Public barrel for the MoltZap client package.

## Public surface

### [`AgentClientOptions`](./../../../protocol/dist/socket/agent-client.d.ts#L13)

_Interface_

Configures agent client.

### [`AppCallbackContext`](./../../../protocol/dist/socket/app-client.d.ts#L14)

_Interface_

Carries context for app callback.

### [`AppCallbackHandlers`](./../../../protocol/dist/socket/app-callbacks.d.ts#L26)

_TypeAlias_

Closed handler table for an app moderating one or more conversations. Every
app callback member is required; vacuous-deny moderators still write the
handler explicitly.

### [`AppClientOptions`](./../../../protocol/dist/socket/app-client.d.ts#L18)

_Interface_

Configures app client.

### [`ContextOptions`](./service.ts#L141)

_Interface_

```ts
export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}
```

Configures context.

### [`ConversationMeta`](./service.ts#L133)

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

### [`MoltZapAgentClient`](./../../../protocol/dist/socket/agent-client.d.ts#L19)

_Class_

Implements molt zap agent client.

### [`MoltZapAppClient`](./../../../protocol/dist/socket/app-client.d.ts#L25)

_Class_

Implements molt zap app client.

### [`MoltZapService`](./service.ts#L279)

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
  private readonly lastReadRef: Ref.Ref<
    HashMap.HashMap<string, HashMap.HashMap<string, ReadonlySet<string>>>
  > = Effect.runSync(
    Ref.make(
      HashMap.empty<string, HashMap.HashMap<string, ReadonlySet<string>>>(),
    ),
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
    dispatchRelease: [],
    dispatchLeaseConsumed: [],
    dispatchLeaseExpired: [],
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

  static startDaemon(
    profileName: string,
  ): Effect.Effect<MoltZapService, unknown> {
    return Effect.gen(function* () {
      const service = yield* MoltZapService.make(profileName);
      yield* service.connect();
      yield* service.startSocketServer();
      return service;
    }).pipe(Effect.withSpan("MoltZapService.startDaemon"));
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
        this.shutdownCompletion = null;
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
```

Stateful MoltZap client that manages connection, conversation tracking,
agent name resolution, and cross-conversation context generation.

API contract: **every fallible method returns `Effect`.** No `*Async`
Promise siblings — async/await consumers run the Effect at the edge
with `Effect.runPromise`. Keep this class Effect-only so downstream
callers compose failures and cancellation explicitly.

### [`RpcCallOptions`](./../../../protocol/dist/socket/lifecycle.d.ts#L12)

_Interface_

Configures rpc call.

### [`ServiceRpcError`](./service.ts#L121)

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

- `service.ts`
