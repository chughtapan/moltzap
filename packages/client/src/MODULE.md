# client/src

_`packages/client/src`_

## Purpose

Public barrel for the MoltZap client package.

## Public surface

### [`AgentClientOptions`](./agent-client.ts#L110)

_Interface_

```ts
export interface AgentClientOptions {
  serverUrl: string;
  agentKey: string;
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: ConnectResult) => void;
}
```

### [`ChannelCoreOptions`](./channel-core.ts#L209)

_Interface_

```ts
export interface ChannelCoreOptions {
  service: ChannelService;
  dispatchAdmissionTimeoutMs?: number;
}
```

### [`ChannelService`](./channel-core.ts#L138)

_Interface_

```ts
export interface ChannelService {
  readonly ownAgentId: string | undefined;
  on(
    event: "message",
    handler: (payload: { taskId: TaskId; message: Message }) => void,
  ): void;
  on(event: "disconnect", handler: () => void): void;
  on(event: "reconnect", handler: () => void): void;
  on(
    event: "conversationArchived",
    handler: (data: { conversationId: string }) => void,
  ): void;
  on(
    event: "conversationUnarchived",
    handler: (data: { conversationId: string }) => void,
  ): void;
  on(
    event: "dispatchRelease",
    handler: (frame: DispatchReleaseFrame) => void,
  ): void;
  connect(): Effect.Effect<unknown, ServiceRpcError>;
  close(): void;
  send(
    taskId: TaskId,
    conversationId: ConversationId,
    text: string,
    opts?: { replyTo?: MessageId; dispatchLeaseId?: LeaseId },
  ): Effect.Effect<void, ServiceRpcError>;
  isConversationArchived?(conversationId: string): boolean;
  getConversation(
    convId: string,
  ): { type: string; name?: string; participants: string[] } | undefined;
  getAgentName(agentId: string): string | undefined;
  resolveAgentName(agentId: string): Effect.Effect<string, never>;
  peekContextEntries(
    currentConvId: string,
    opts?: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void };
  peekFullMessages(currentConvId: string): {
    messages: CrossConvMessage[];
    commit: () => void;
  };

  /**
   * Issue `dispatch/request` and receive the immediate
   * `{leaseId, dispatchId}` ack. The verdict arrives asynchronously
   * via the `dispatchRelease` event.
   *
   * The argument shape mirrors `ParamsOf&lt;DispatchRequest>` from the
   * protocol (the channel core does not depend on the protocol
   * descriptor, hence the structural shape duplicated here).
   *
   * Optional: when undefined (e.g. unauthenticated test fakes), the
   * channel core falls back to default-grant — every inbound message
   * dispatches without admission.
   */
  requestDispatch?(params: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderAgentId: string;
    readonly parts?: ReadonlyArray<unknown>;
    readonly receivedAt?: string;
    readonly pending?: ReadonlyArray<unknown>;
    readonly clock?: LogicalClock;
    readonly attempt?: number;
  }): Effect.Effect<
    { readonly leaseId: LeaseId; readonly dispatchId: string },
    ServiceRpcError
  >;
}
```

The subset of MoltZapService that MoltZapChannelCore needs.

### [`ContextBlocks`](./channel-core.ts#L38)

_Interface_

```ts
export interface ContextBlocks {
  groupMetadata?: EnrichedConversationMeta;
  crossConversation?: CrossConversationEntry[];
  crossConversationMessages?: CrossConvMessage[];
}
```

### [`ContextOptions`](./service.ts#L158)

_Interface_

```ts
export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}
```

### [`ConversationMeta`](./service.ts#L151)

_Interface_

```ts
export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}
```

### [`CrossConversationEntry`](./service.ts#L165)

_Interface_

```ts
export interface CrossConversationEntry {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  text: string;
  minutesAgo: number;
  /** Messages in this summary (capped by maxMessagesPerConv). */
  count: number;
}
```

Structured summary of recent activity in one other conversation.

### [`CrossConvMessage`](./service.ts#L240)

_Interface_

```ts
export interface CrossConvMessage {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  senderId: string;
  text: string;
  timestamp: string;
}
```

Full message from another conversation, used by peekFullMessages().

### [`DispatchAdmissionDecision`](./channel-core.ts#L92)

_TypeAlias_

```ts
export type DispatchAdmissionDecision =
  | {
      _tag: "grant";
      leaseId?: LeaseId;
      leaseTimeoutMs?: number;
      dispatchMessageId?: string;
    }
```

### [`DispatchAdmissionRequest`](./channel-core.ts#L82)

_Interface_

```ts
export interface DispatchAdmissionRequest {
  message: Message;
  conversationId: string;
  senderAgentId: string;
  attempt: number;
  receivedAt: string;
  clock: LogicalClock;
  pending: ReadonlyArray<PendingDispatchMessage>;
}
```

### [`DispatchReleaseFrame`](./channel-core.ts#L122)

_Interface_

```ts
export interface DispatchReleaseFrame {
  readonly dispatchId: string;
  readonly leaseId: LeaseId;
  readonly verdict:
    | {
        readonly decision: "grant";
        readonly leaseId?: LeaseId;
        readonly leaseTimeoutMs?: number;
        readonly dispatchMessageId?: string;
      }
    | { readonly decision: "deny"; readonly reason?: string }
    | { readonly decision: "hold"; readonly reason?: string };
  readonly leaseTimeoutMs?: number;
}
```

Server → recipient `dispatch/release` notification payload (the
verdict). Mirrors `NotificationParamsOf&lt;typeof DispatchRelease>` from
the protocol, kept structurally typed here so this module does not
need a direct protocol descriptor import (the channel core stays
descriptor-free; the wire shape is asserted by the service module).

### [`drainPaginatedList`](./pagination.ts#L50)

_Function_

```ts
export function drainPaginatedList<
  E,
  D extends RpcDefinition<string, any, any>,
  K extends keyof ResultOf<D>,
>(
  sendRpc: SendRpcFn<E>,
  definition: D,
  collectionKey: K,
): Effect.Effect<ResultOf<D>[K], E | NonAdvancingCursorError>
```

Drain every page of a cursor-paginated list RPC whose result is
`{ [K]: T[], nextCursor? }`, echoing the opaque `nextCursor` back as the
next page's `cursor`. Fails with NonAdvancingCursorError if the
server returns a cursor it already emitted (cycle guard).

### [`EnrichedConversationMeta`](./channel-core.ts#L31)

_Interface_

```ts
export interface EnrichedConversationMeta {
  type: "dm" | "group";
  name?: string;
  /** "type:id" strings (e.g. "agent:uuid"). */
  participants: string[];
}
```

### [`EnrichedInboundMessage`](./channel-core.ts#L44)

_Interface_

```ts
export interface EnrichedInboundMessage {
  id: string;
  taskId: TaskId;
  conversationId: ConversationId;
  sender: EnrichedSender;
  /** Text parts joined with newlines. Non-text parts dropped. */
  text: string;
  isFromMe: boolean;
  createdAt: string;
  replyToId?: string;
  conversationMeta?: EnrichedConversationMeta;
  contextBlocks: ContextBlocks;

  /**
   * Present when multiple queued messages from the same conversation were
   * coalesced into this single dispatch. Includes the primary message first.
   */
  coalescedMessages?: ReadonlyArray<{
    id: string;
    sender: EnrichedSender;
    text: string;
    createdAt: string;
    replyToId?: string;
  }>;
  /** Lease that authorizes a runtime reply for this dispatch, when present. */
  dispatchLeaseId?: LeaseId;
}
```

### [`EnrichedSender`](./channel-core.ts#L26)

_Interface_

```ts
export interface EnrichedSender {
  id: string;
  name: string;
}
```

### [`formatCrossConversationBlock`](./service.ts#L185)

_Function_

```ts
export function formatCrossConversationBlock(
  entries: CrossConversationEntry[],
  opts: { header: string },
): string | null
```

Format CrossConversationEntry[] as a `&lt;system-reminder>` block. Adapters
that inline context into prompt text (nanoclaw) and `MoltZapService.getContext`
share this formatter so sanitization and line shape stay in one place.

### [`InboundHandler`](./channel-core.ts#L220)

_TypeAlias_

```ts
export type InboundHandler<E = unknown> = (
  msg: EnrichedInboundMessage,
) => Effect.Effect<void, E>;
```

Handler invoked for every enriched inbound message. Returns an Effect so the
error channel is part of the type — callers fail with a tagged error and the
consumer fiber logs it instead of dropping it on the floor like a Promise
rejection would.

### [`MoltZapAgentClient`](./agent-client.ts#L122)

_Class_

```ts
export class MoltZapAgentClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;
  private readonly subscribers: SubscriberRegistry;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: AgentClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
    this.subscribers = this.runtime.runSync(makeSubscriberRegistry());
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  connect(): Effect.Effect<ConnectResult, ConnectError> {
    return this.runtime.runtimeEffect.pipe(
      Effect.flatMap(() => this.connectEffect()),
      Effect.provide(this.runtime),
    );
  }

  /**
   * Outbound RPC. The compile-time constraint accepts any
   * `RpcDefinition` so generic forwarders (service.sendRpc, CLI
   * transport) can pass through without per-method narrowing; the R11
   * agent-client catalog narrowing applies at runtime inside
   * `AgentClientConnection` and rejects TM-only methods.
   */
  sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.sendRpcEffect(definition, params, timeoutMs);
  }

  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, NotConnectedError, never>;
  subscribe<
    D extends AnyNotificationDefinition,
    R extends NotificationParamsOf<D>,
  >(
    definition: D,
    refinement: (params: NotificationParamsOf<D>) => params is R,
  ): Stream.Stream<DecodedNotification<D, R>, NotConnectedError, never>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional refinement is a value-level passthrough to the Stream factory; not a refinement-of-discriminant decision
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, NotConnectedError, never> {
    return subscribeStream(this.subscribers, definition, refinement);
  }

  subscribeAll(
    // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional refinement is a value-level passthrough to the Stream factory; not a refinement-of-discriminant decision
    refinement?: (
      notification: DecodedNotification<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    NotConnectedError,
    never
  > {
    return subscribeAllStream(this.subscribers, refinement);
  }

  close(): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      if (this.closed) return;
      const hasCompletedHandshake = this._helloOk !== null;
      this.closed = true;
      this._helloOk = null;
      if (this.reconnectFiber !== null) {
        const f = this.reconnectFiber;
        this.reconnectFiber = null;
        yield* Effect.forkDaemon(Fiber.interrupt(f));
      }
      yield* this.failAllPending(MSG_NOT_CONNECTED);
      yield* this.subscribers.closeAll;
      const state = yield* Ref.getAndSet(this.stateRef, Option.none());
      if (Option.isSome(state)) {
        if (hasCompletedHandshake) {
          yield* state.value
            .write(new Socket.CloseEvent(NORMAL_CLOSE_CODE, "normal"))
            .pipe(Effect.orDie);
          yield* Scope.close(state.value.scope, Exit.void);
        } else {
          this.runtime.runFork(Scope.close(state.value.scope, Exit.void));
        }
      }
    }).pipe(
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => {
          this.runtime.dispose();
        }),
      ),
    );
  }

  disconnect(): Effect.Effect<void, never> {
    return Effect.sync(() => this.disconnectSync());
  }

  private disconnectSync(): void {
    const state = this.runtime.runSync(Ref.get(this.stateRef));
```

MoltZap agent client — outbound RPC only, no TM-callback inbound
dispatch. `request` is narrowed to `AnyAgentClientRpcDefinition`; TM-only
methods are unreachable at compile time (Spec D3 R11/R13).

### [`MoltZapChannelCore`](./channel-core.ts#L324)

_Class_

```ts
export class MoltZapChannelCore {
  private readonly service: ChannelService;
  private readonly dispatchAdmissionTimeoutMs: number;
  private connected = false;
  private inboundHandler: InboundHandler<unknown> | null = null;

  /**
   * Lease id scoped to the in-flight `dispatchInboundEffect` call
   * (set immediately around the user-handler invocation). Replaces
   * the legacy `activeDispatchLeaseId` field whose semantics were
   * unchanged but whose name leaked an admission-flow detail. The
   * field remains a single mutable cell because the consumer fiber
   * processes inbound work strictly serially (one queue, one fiber);
   * concurrent dispatches do not exist on this code path.
   */
  private leaseIdInFlight: LeaseId | undefined;

  /**
   * Per-lease parking Deferreds for dispatches awaiting their
   * `dispatchRelease` verdict. Settled by the `dispatchRelease` event
   * handler when a matching frame arrives.
   */
  private readonly pendingDispatchesByLease = new Map<
    string,
    Deferred.Deferred<DispatchReleaseFrame, never>
  >();

  /**
   * Ring buffer of `dispatchRelease` frames that arrived before the
   * recipient registered its parking Deferred (release-then-ack
   * race). Bounded LRU via Map insertion-order iteration; soft-TTL
   * eviction at `DISPATCH_RELEASE_RING_SOFT_TTL_MS` so a release
   * without a matching ack does not leak memory.
   */
  private readonly pendingReleasesByLease = new Map<
    string,
    PendingReleaseEntry
  >();
  private readonly closedConversationIds = new Set<string>();
  private readonly logicalClocks = new Map<
    string,
    { epoch: number; vector: Record<string, number> }
  >();
  private readonly parkedByConversation = new Map<
    string,
    InboundDispatchWork[]
  >();

  /**
   * Inbound messages enqueue synchronously; a single forked consumer fiber
   * serialises delivery so handlers execute one-at-a-time in arrival order.
   */
  private readonly inboundQueue: Queue.Queue<InboundDispatchWork> =
    Effect.runSync(Queue.unbounded<InboundDispatchWork>());
  private readonly consumerFiber: Fiber.RuntimeFiber<void, never>;
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.dispatchAdmissionTimeoutMs =
      opts.dispatchAdmissionTimeoutMs ?? DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS;

    this.registerMessageListener();
    this.consumerFiber = this.startConsumerFiber();
    this.registerConnectionListeners();
    this.registerConversationLifecycleListeners();
    this.registerDispatchReleaseListener();
  }

  private registerMessageListener(): void {
    this.service.on("message", ({ taskId, message }) => {
      if (this.closedConversationIds.has(message.conversationId)) {
        runBackgroundLog(
          effectLogInfo(
            "MoltZapChannelCore: dropping inbound message for closed conversation",
            {
              messageId: message.id,
              conversationId: message.conversationId,
            },
          ),
        );
        return;
      }
      Queue.unsafeOffer(this.inboundQueue, {
        taskId,
        message,
        attempt: 0,
        receivedAtMs: Date.now(),
        clock: this.observeMessage(message),
      });
    });
  }

  private startConsumerFiber(): Fiber.RuntimeFiber<void, never> {
    const consumer = Effect.forever(
      Queue.take(this.inboundQueue).pipe(
        Effect.flatMap((work) =>
          this.dispatchInboundWork(work).pipe(
            Effect.catchAllCause((cause) =>
              this.logInboundFailure(work, cause),
            ),
          ),
        ),
      ),
    );
    return Effect.runFork(consumer);
  }

  private logInboundFailure(
    work: InboundDispatchWork,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void, never> {
    return effectLogError("MoltZapChannelCore: inbound handler failed", {
      messageId: work.message.id,
      conversationId: work.message.conversationId,
      causePretty: Cause.pretty(cause),
      ...errorSummary(Cause.squash(cause)),
    });
  }
```

Wraps a `MoltZapService` with message enrichment, dispatch-chain ordering,
and a send helper. One core per service — `getContextEntries()` is
side-effectful (advances per-conversation markers), so a second core
would consume entries the first expected.

Inbound path from wire bytes to user handler:

```mermaid
sequenceDiagram
  participant server
  participant ws as MoltZapAgentClient
  participant svc as MoltZapService
  participant core as MoltZapChannelCore
  participant handler as InboundHandler

  server->>ws: messages/received notification
  ws->>svc: subscribers.dispatch — fanout(message)
  svc->>core: message listener
  Note over core: dedup via recordMessageIdIfNew<br>Queue.unsafeOffer(inboundQueue, work)
  Note over core: consumer fiber — Queue.take<br>takeDispatchCandidate prefers parked[convId]
  core->>server: dispatch/request — dispatchAdmission
  server-->>core: ack {leaseId, dispatchId}
  Note over server,core: ack/release race absorbed via<br>pendingDispatchesByLease (Deferred)<br>pendingReleasesByLease (ring 256, soft-TTL 30s)
  server->>ws: dispatch/release notification
  ws->>core: recordDispatchRelease — settles Deferred or buffers
  alt verdict deny
    Note over core: log + drop
  else verdict hold
    Note over core: parkDispatchWork — front of parked[convId]
  else verdict grant
    Note over core: takeCoalescedConversationMessages<br>drains same-conv from queue + parked
    Note over core: dispatchWithLease<br>leaseIdInFlight = leaseId<br>enrichMessage — sender name, conversation, context entries
    core->>handler: inboundHandler(enriched)
    handler-->>core: Effect.void
    Note over core: handler exceeds leaseTimeoutMs (90s) → DispatchLeaseExpired
  end
```

Parking semantics: `hold` re-enters at `parked[convId]` FRONT.
`takeDispatchCandidate` prefers the parked queue for the next pull
so backpressure within one conversation does not starve others.

### [`MoltZapService`](./service.ts#L292)

_Class_

```ts
export class MoltZapService {
  private client: MoltZapAgentClient | null = null;
  private _connected = false;

  /**
   * Service-owned scope (spec #596 / Spec B §"4.2 service.ts" lifecycle
   * reshape). Opened in `connect()`, owns the `subscribeAll → Stream.runForEach`
   * fan-out fiber. Closed in `close()` so the fiber terminates with the
   * service.
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
    dispatchesConsumed: [],
    dispatchesExpired: [],
  };
  private readonly notificationDispatchers = new Map<
    AnyNotificationDefinition,
    NotificationDispatcher
  >([
    [
      MessageReceivedNotificationDefinition,
      (notification) =>
        this.handleMessageReceivedNotification(
          notification.params as MessageReceivedNotification,
        ),
    ],
    [
      TaskConversationCreatedNotificationDefinition,
      (notification) =>
        this.handleConversationCreatedNotification(
          notification.params as TaskConversationCreatedNotification,
        ),
    ],
    [
      TaskConversationArchivedNotificationDefinition,
      (notification) =>
        this.handleConversationArchivedNotification(
          notification.params as TaskConversationArchivedNotification,
        ),
    ],
    [
      TaskConversationUnarchivedNotificationDefinition,
      (notification) =>
        this.handleConversationUnarchivedNotification(
          notification.params as TaskConversationUnarchivedNotification,
        ),
    ],
    [
      DispatchRelease,
      (notification) =>
        fanout(
          this.handlers.dispatchRelease,
          notification.params as NotificationParamsOf<typeof DispatchRelease>,
        ),
    ],
    [
      DispatchesConsumed,
      (notification) =>
        fanout(
          this.handlers.dispatchesConsumed,
```

Stateful MoltZap client that manages connection, conversation tracking,
agent name resolution, and cross-conversation context generation.

API contract: **every fallible method returns `Effect`.** No `*Async`
Promise siblings — async/await consumers run the Effect at the edge
with `Effect.runPromise`. Keep this class Effect-only so downstream
callers compose failures and cancellation explicitly. (Phase -1
vendored the legacy `@moltzap/app-sdk` Promise-shaped wrapper out
to arena; consumers wanting Promise wrappers maintain their own.)

### [`MoltZapTMClient`](./tm-client.ts#L299)

_Class_

```ts
export class MoltZapTMClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;

  /**
   * Per-subscription notification registry. Spec #596 / Spec B: callback-based
   * storage feeds `Stream.async` consumers via `notification/stream.ts`.
   */
  private readonly subscribers: SubscriberRegistry;

  /**
   * Spec F (#617) immutable TM-callback handler table. Captured from
   * `TMClientOptions.handlers` at construction and threaded through
   * every `makeTaskMasterConnection` call (including reconnects).
   */
  private readonly handlers: TMHandlers;

  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: TMClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
    this.subscribers = this.runtime.runSync(makeSubscriberRegistry());
    this.handlers = options.handlers;
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  /**
   * Open the socket, perform `network/connect`, resolve with HelloOk.
   * Fails immediately on pre-open close or error.
   *
   * ```mermaid
   * sequenceDiagram
   *   participant caller
   *   participant client as MoltZapTMClient
   *   participant server
   *
   *   caller->>client: new MoltZapTMClient(options)
   *   Note over client: stateRef = None, subscribers, ManagedRuntime
   *   caller->>client: subscribe(filter, handler)
   *   Note over client: SubscriberRegistry.register — survives reconnect
   *   caller->>client: connect()
   *   Note over client: connectEffect — Scope.make, Socket.makeWebSocket open<br>startTaskCallbackDispatcher — bounded Queue 8192 + drain<br>readerFiber = runFork(readerEffect)
   *   client->>server: TCP open + WS upgrade
   *   client->>server: network/connect {agentKey, minProtocol, maxProtocol}
   *   server-->>client: HelloOk
   *   Note over client: stateRef = Some(connState), _helloOk = value
   *   client-->>caller: HelloOk
   *   Note over client,server: steady state — reader fiber loops on socket.runRaw
   * ```
   *
   * Reconnect arm fires from `handleReaderExit` when the reader fiber
   * exits with `closed === false`. `failAllPending` settles every
   * in-flight Deferred with `NotConnectedError`, `notifyDisconnect`
   * surfaces the close info, then `scheduleReconnect` forks an
   * exponential-backoff retry (`1s × 2^n, cap 30s, +jitter`).
   *
   * State that SURVIVES reconnect: `SubscriberRegistry` entries,
   * `appCallbackHandlers` (immutable, value-captured at construction),
   * `ManagedRuntime`.
   *
   * State that does NOT survive reconnect: in-flight RPC Deferreds
   * (failed via `failAllPending`), the prior `ConnState` (scope,
   * reader fiber, callback queue, dispatcher scope) — rebuilt fresh.
   */
  connect(): Effect.Effect<ConnectResult, ConnectError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(makeNotConnectedError());
      }
      return this.connectEffect().pipe(
        // `makeWebSocket` requires `Socket.WebSocketConstructor`; our
        // internal Node layer provides it so callers' Effects stay
        // requirement-free (same public shape the legacy client had).
        Effect.provide(NodeSocket.layerWebSocketConstructor),
      );
    });
  }

  /**
   * Send an RPC. Fails with a typed error:
   *   - `NotConnectedError` if the socket isn't OPEN or closes mid-RPC
   *   - `RpcTimeoutError` after `RPC_TIMEOUT_MS` — no automatic retry
   *   - a registered tagged error for known protocol error codes
   *   - `RpcServerError` for unknown protocol error codes
   *
   * Descriptor-backed RPC call. Callers pass the protocol descriptor, and the
   * client extracts the wire method only inside the encoder path.
   */
  sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.sendRpcEffect(definition, params, timeoutMs);
  }

  /**
   * Typed-payload subscribe (spec #596 Goal #1). Returns a Stream of
   * `DecodedNotification<D>` whose error channel is `NotConnectedError`
   * and whose requirement set is `never`.
   *
   * `refinement` is a typed predicate over the definition's params shape.
   * The user-defined-type-guard overload (signature below) narrows the
   * Stream's payload to `DecodedNotification<D, R>`.
   *
   * Lifecycle (spec §"Stream lifecycle contract"):
```

WebSocket lifecycle: open → network/connect → active. On disconnect,
exponential backoff (1s base, 30s cap, jittered) retries the handshake via
`Effect.sleep` + `Schedule` so TestClock can drive it. Public API is
Effect-based — consumers run the returned Effects themselves (typically at
a framework or CLI edge).

Connection state machine, driven by `stateRef` (`None` | `Some(ConnState)`)
and the `closed` flag:

```mermaid
stateDiagram-v2
  [*] --> INIT
  INIT : stateRef None, closed false
  INIT --> CONNECTING : connect()
  CONNECTING : openSocket 10s timeout<br>startTaskCallbackDispatcher<br>readerFiber forked<br>sendRpc(Connect) in flight
  CONNECTING --> CONNECTED : HelloOk received<br>stateRef = Some(ConnState)
  CONNECTED : _helloOk set, reader fiber active
  CONNECTED --> DISCONNECTED : reader fiber exit<br>failAllPending, stateRef = None<br>onDisconnect(closeInfo)
  DISCONNECTED : reconnectable, closed false
  DISCONNECTED --> CONNECTING : scheduleReconnect<br>exponential backoff 1s..30s jittered<br>connectEffect → onReconnect(helloOk)
  INIT --> CLOSED : close()
  CONNECTING --> CLOSED : close()
  CONNECTED --> CLOSED : close()
  DISCONNECTED --> CLOSED : close()
  CLOSED : terminal — closed true<br>stateRef None, reconnectFiber null<br>no further reconnects
  CLOSED --> [*]
```

`close()` is total from any state: interrupts the reconnect fiber,
`failAllPending` + `failAllNotificationWaiters`, `subscribers.closeAll`,
writes `CloseEvent(1000)` if the handshake completed, closes the
connection and dispatcher scopes, disposes the `ManagedRuntime`.

Transport: `@effect/platform/Socket.makeWebSocket` backed by
`@effect/platform-node/NodeSocket.layerWebSocketConstructor`. The Node
`WebSocketConstructor` layer is provided internally via `ManagedRuntime`
so callers' `connect()` / `sendRpc()` Effects have no extra requirement.

Notification consumption: use `subscribe(def, refinement?)` for typed
payload Streams; `subscribeAll(refinement?)` for the broad-union
escape hatch. Both return `Stream.Stream` of `DecodedNotification` with
a `NotConnectedError` error channel. Consume via `Stream.runForEach`
(long-lived) or `Stream.runHead` + `Effect.timeoutFail` (one-shot).

### [`NonAdvancingCursorError`](./pagination.ts#L23)

_Class_

```ts
export class NonAdvancingCursorError extends Data.TaggedError(
  "NonAdvancingCursorError",
)<{
  readonly method: string;
}> {
  override get message(): string {
    return `Pagination cursor for ${this.method} did not advance — refusing to loop`;
  }
}
```

A server that returns a non-advancing `nextCursor` (one already seen)
would loop the drain forever; fail typed so the caller's `catchAll`
can degrade gracefully instead of hanging. This is a cycle guard, NOT
a page cap — a well-behaved server never trips it.

### [`PendingDispatchMessage`](./channel-core.ts#L72)

_Interface_

```ts
export interface PendingDispatchMessage {
  messageId: string;
  conversationId: string;
  senderAgentId: string;
  createdAt: string;
  receivedAt: string;
  clock?: LogicalClock;
  parts?: Message["parts"];
}
```

### [`registerAgent`](./auth.ts#L56)

_Function_

```ts
export const registerAgent = (
  baseUrl: string,
  name: string,
  opts: RegisterAgentOptions = {},
): Effect.Effect<RegisterResponse, RegisterAgentError>
```

Register a new agent via HTTP. Thin wrapper around the agent-registration
endpoints — the WebSocket dance is `MoltZapAgentClient`'s job; this just
returns the credentials the caller feeds it as `agentKey` at construction.

Routes to `/api/v1/admin/register-agent` when `ownerUserId` is provided
(admin path pre-claims the agent for the given owner); otherwise routes
to the public `/api/v1/auth/register` endpoint.

### [`RegisterAgentOptions`](./auth.ts#L21)

_Interface_

```ts
export interface RegisterAgentOptions {
  description?: string;
  inviteCode?: string;

  /**
   * When set, registers via the secret-gated admin endpoint and pre-claims
   * the agent for this user. See {@link registerAgent}.
   */
  ownerUserId?: string;
}
```

Options for registerAgent.

### [`RegisterResponse`](./auth.ts#L13)

_Interface_

```ts
export interface RegisterResponse {
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}
```

HTTP response from the agent registration endpoints
(`/api/v1/auth/register` and `/api/v1/admin/register-agent`).

### [`RpcCallOptions`](./tm-client.ts#L63)

_Interface_

```ts
export interface RpcCallOptions {
  readonly timeoutMs?: number;
}
```

### [`sanitizeForSystemReminder`](./service.ts#L176)

_Function_

```ts
export function sanitizeForSystemReminder(s: string): string
```

Escape `&lt;`, `>`, `&amp;` so sender content can't escape a `&lt;system-reminder>` block.

### [`SendRpcFn`](./pagination.ts#L39)

_TypeAlias_

```ts
export type SendRpcFn<E> = <D extends RpcDefinition<string, any, any>>(
  definition: D,
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, E>;
```

The `sendRpc` shape every drain consumer provides: send one list-RPC
page, decoding its typed result. Parameterized over the sender's error
channel `E` so the helper stays decoupled from any one client's error
union.

### [`ServiceOptions`](./service.ts#L205)

_Interface_

```ts
export interface ServiceOptions {
  serverUrl: string;
  agentKey: string;
}
```

### [`ServiceRpcError`](./service.ts#L149)

_TypeAlias_

```ts
export type ServiceRpcError = RpcCallError | RpcTimeoutError;

export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}
```

Errors that can surface from the Effect-based service API. Matches the
failure channel of `MoltZapAgentClient.sendRpc` / `connect`.

### [`TaskCallbackContext`](./tm-client.ts#L198)

_Interface_

```ts
export interface TaskCallbackContext {
  readonly requestId: JsonRpcId;
}
```

Per-frame context the WS client threads through the Spec F typed
dispatcher when invoking a TM-callback handler. The dispatcher reads
the slot's definition off the static handler table — handlers only need
the request id (e.g. for tracing / logging). The empty `traceparent`
passthrough is intentional: when the wire frame carries an OTel
traceparent header, the surrounding transport may layer it on; the
typed-dispatcher does not encode tracing into the type.

### [`TMClientOptions`](./tm-client.ts#L211)

_Interface_

```ts
export interface TMClientOptions {
  serverUrl: string;
  agentKey: string;

  /**
   * D #705 CP8 — app-principal credential. When set, the `network/connect`
   * handshake uses the `appKey` arm (`{ appKey, minProtocol, maxProtocol }`)
   * instead of the `agentKey` arm, so the server mints an `AppConnection`
   * and the HelloOk carries no `agentId`. Used by wire app clients (a
   * moderator app authenticating as an app principal); wire agent clients
   * leave it unset and authenticate via `agentKey`. The two are mutually
   * exclusive at the wire — the Connect params union is disjoint — so a
   * configured `appKey` wins the handshake-credential selection in
   * `awaitConnectAuth`. (The boot-installed default app is NOT a client: it
   * registers a hookless manifest server-side and is served by AppHost's
   * manifest-default fast-path.)
   */
  appKey?: string;

  /**
   * Called once per disconnect (not reconnect). Spec #222 §5.4 + OQ-5 (A):
   * `close` is the typed close metadata — real WebSocket `{code, reason}`
   * when the transport surfaces them, OQ-5 defaults otherwise.
   *
   * Migration note (spec #596): the previous `subscribe(filter, handler)` /
   * `waitForNotification` / `notificationsBufferRef` surface was deleted in
   * Spec B. Callers consume notifications via `subscribe(def, refinement?)`
   * returning a `Stream`, or `subscribeAll(refinement?)` for the broad-union
   * escape hatch.
   */
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: ConnectResult) => void;

  /**
   * Spec D3 R14b — REQUIRED. TM-callback handler table immutable at
   * construction (Spec F I1). Keys are catalog method names
   * (`"dispatch/authorize"`, `"messages/authorize"`); each value carries
   * the matching `defineRpc` descriptor and its handler effect.
   * Vacuous-deny moderators write the explicit ForbiddenError handler.
   */
  handlers: TMHandlers;
}
```

### [`TMHandlers`](./tm-client.ts#L209)

_TypeAlias_

```ts
export type TMHandlers = TaskMasterHandlers<TaskCallbackContext>;
```

Public handler-table type for `TMClientOptions.handlers`.
Re-exposes the protocol's `TaskMasterHandlers` mapped type bound to the
client's per-frame context. Spec D3 R14b made every slot REQUIRED;
vacuous-deny moderators bind an explicit `ForbiddenError -32001`
handler.

## Files

- `agent-client.ts`
- `auth.ts`
- `channel-core.ts`
- `pagination.ts`
- `service.ts`
- `tm-client.ts`
