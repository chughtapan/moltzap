# client/src

_`packages/client/src`_

## Purpose

Public barrel for the MoltZap client package.

## Public surface

### [`ContextOptions`](./service.ts#L189)

_Interface_

```ts
export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}
```

### [`ConversationMeta`](./service.ts#L182)

_Interface_

```ts
export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}
```

### [`MoltZapService`](./service.ts#L318)

_Class_

```ts
export class MoltZapService {
  private client: MoltZapAgentClient | null = null;
  private _connected = false;

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
    HashMap.HashMap<string, ReadonlyArray<Message>>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ReadonlyArray<Message>>()));
  private readonly agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>> =
    Effect.runSync(Ref.make(HashMap.empty<string, string>()));
  private readonly agentConversationCacheRef: Ref.Ref<
    HashMap.HashMap<
      string,
      { readonly taskId: TaskId; readonly conversationId: ConversationId }
    >
  > = Effect.runSync(
    Ref.make(
      HashMap.empty<
        string,
        { readonly taskId: TaskId; readonly conversationId: ConversationId }
      >(),
    ),
  );
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
  private readonly archivedConversationIds = new Set<string>();

  /**
   * Insertion-ordered set of recently seen messageIds per conversation.
   * Bounded at DEDUP_WINDOW_PER_CONV entries per conversation; oldest entry
   * is evicted when the window is full. Set#keys() preserves insertion
   * order in V8 / the spec, so eviction via `.next()` is O(1).
   *
   * Keyed and valued by their branded ids so the compiler rejects a
   * `MessageId` accidentally used as a conversation key (or vice versa).
   */
  private readonly seenMessageIds = new Map<ConversationId, Set<MessageId>>();
  private readonly handlers: {
    [K in ServiceHandlerName]: Array<
      NotificationHandler<ServiceHandlerPayloads[K]>
    >;
  } = {
    message: [],
    rawNotification: [],
    disconnect: [],
    reconnect: [],
    conversationArchived: [],
    conversationUnarchived: [],
    dispatchRelease: [],
    dispatchLeaseConsumed: [],
    dispatchLeaseExpired: [],
  };

  private _ownAgentId: AgentId;

  protected constructor(private opts: ServiceOptions) {
    // The empty HelloOk carries no identity; `ownAgentId` is the client's
    // registered/stored id, available before the handshake.
    this._ownAgentId = opts.agentId;
  }

  static fromConfig(config: MoltzapServiceConfig): MoltZapService {
    return new MoltZapService(config);
  }

  static make(
    profileName: string,
  ): Effect.Effect<MoltZapService, ServiceConfigError> {
    return loadServiceConfig(profileName).pipe(
      Effect.map(MoltZapService.fromConfig),
    );
  }

  static startDaemon(
    profileName: string,
  ): Effect.Effect<
    MoltZapService,
    ServiceConfigError | ServiceRpcError | unknown
  > {
    return Effect.gen(function* () {
      const service = yield* MoltZapService.make(profileName);
      yield* service.connect();
      yield* service.startSocketServer();
      return service;
    }).pipe(Effect.withSpan("MoltZapService.startDaemon"));
  }

  get connected(): boolean {
    return this._connected;
  }

  get ownAgentId(): AgentId | undefined {
    return this._ownAgentId;
  }

  /** Effect-native: compose via `yield*` or bridge at the edge via `Effect.runPromise`. */
  connect(): Effect.Effect<HelloOk, ServiceRpcError> {
    return Effect.gen(this, function* () {
```

Stateful MoltZap client that manages connection, conversation tracking,
agent name resolution, and cross-conversation context generation.

API contract: **every fallible method returns `Effect`.** No `*Async`
Promise siblings — async/await consumers run the Effect at the edge
with `Effect.runPromise`. Keep this class Effect-only so downstream
callers compose failures and cancellation explicitly.

### [`ServiceRpcError`](./service.ts#L177)

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
