/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import {
  AgentsLookup,
  AgentsLookupByName,
  type HelloOk,
  type AnyNotificationDefinition,
  type AnyServerRpcDefinition,
  type DecodedNotification,
  DispatchRequest,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  type DispatchId,
  type Message,
  type MessageReceivedNotification,
  type TaskConversationCreatedNotification,
  type TaskConversationArchivedNotification,
  type TaskConversationUnarchivedNotification,
  MessageReceivedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  ConversationArchivedError,
  DEFAULT_APP_ID,
  MessagesList,
  MessagesSend,
  TaskRequest,
  TaskConversationList,
  NotConnectedError,
  serverRpcMethods,
  type RpcCallError,
  RpcServerError,
  RpcTimeoutError,
  type NotificationParamsOf,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type {
  ConversationId,
  LeaseId,
  MessageId,
  TaskId,
} from "@moltzap/protocol/task";
import {
  Config,
  ConfigProvider,
  Effect,
  HashMap,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import { MoltZapAgentClient, type RpcCallOptions } from "./agent-client.js";
import { AgentNotFoundError } from "./runtime/errors.js";
import { getOr, snapshot } from "./runtime/refs.js";
import { LocalServiceCommands } from "./runtime/local-service-commands.js";
import {
  getMoltZapAgentServiceSocketPath,
  getMoltZapServiceSocketPath,
} from "./local-paths.js";
import type { LocalDaemonParams } from "./local-daemon-rpc.js";
import {
  startLocalSocketServer,
  stopLocalSocketServer,
} from "./runtime/local-socket-server.js";
import {
  buildContextEntries,
  type ContextCandidate,
  type CrossConvState,
  makeContextCandidate,
  newMessagesForConversation,
  notificationTraceRecord,
  renderPart,
  ServiceInputError,
} from "./runtime/service-helpers.js";
import {
  decodeHistoryRequest,
  formatHistoryMessage,
  type HistoryRequestInputError,
  type HistoryRequest,
  type HistoryResponse,
  lastReadIdsForSession,
} from "./runtime/local-history.js";
import { composeServiceTeardown } from "./runtime/service-teardown.js";
import {
  purgeAgentCacheEntries,
  purgeLastNotified,
  purgeLastRead,
} from "./service-archive-purge.js";

const CROSS_CONTEXT_TEXT_LIMIT = 120;
const DEFAULT_MAX_CONTEXT_CONVERSATIONS = 5;
const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 3;
const HISTORY_LOOKUP_CONCURRENCY = 2;
const SEND_TO_AGENT_LOOKUP_PAGE_SIZE = 50;
const SEND_TO_AGENT_LOOKUP_MAX_PAGES = 20;

const ClientEventLogDir = Config.option(
  Config.string("MOLTZAP_CLIENT_EVENT_LOG_DIR"),
);

const getClientEventLogDir = (): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      ClientEventLogDir.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );

function appendClientEventTrace(
  record: Record<string, unknown>,
): Effect.Effect<void, never> {
  const dir = getClientEventLogDir();
  if (!dir) return Effect.void;
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agentId =
      typeof record["agentId"] === "string" ? record["agentId"] : "unknown";
    const safeAgentId = /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : "unknown";
    yield* Effect.zipRight(
      fileSystem.makeDirectory(dir, { recursive: true }),
      fileSystem.writeFileString(
        path.join(dir, `client-events-${safeAgentId}.jsonl`),
        JSON.stringify(record) + "\n",
        { flag: "a" },
      ),
    );
  }).pipe(
    Effect.withSpan("appendClientEventTrace"),
    Effect.provide(NodeContext.layer),
    Effect.catchAll((err) =>
      Effect.logWarning("moltzap client event trace write failed", err),
    ),
  );
}

/**
 * Errors that can surface from the Effect-based service API. Matches the
 * failure channel of `MoltZapAgentClient.sendRpc` / `connect`.
 */
export type ServiceRpcError = RpcCallError | RpcTimeoutError;

export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}

export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}

/** Structured summary of recent activity in one other conversation. */
export interface CrossConversationEntry {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  text: string;
  minutesAgo: number;
  /** Messages in this summary (capped by maxMessagesPerConv). */
  count: number;
}

/** Escape `&lt;`, `>`, `&amp;` so sender content can't escape a `&lt;system-reminder>` block. */
export function sanitizeForSystemReminder(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format CrossConversationEntry[] as a `&lt;system-reminder>` block. Adapters
 * that inline context into prompt text (nanoclaw) and `MoltZapService.getContext`
 * share this formatter so sanitization and line shape stay in one place.
 */
export function formatCrossConversationBlock(
  entries: CrossConversationEntry[],
  opts: { header: string },
): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((e) => {
    const safeSender = sanitizeForSystemReminder(e.senderName);
    const safeText = sanitizeForSystemReminder(
      e.text.slice(0, CROSS_CONTEXT_TEXT_LIMIT),
    );
    return `@${safeSender} (${e.minutesAgo}m ago): (${e.count} new) "${safeText}"`;
  });
  return [
    "<system-reminder>",
    opts.header,
    ...lines,
    "</system-reminder>",
  ].join("\n");
}

export interface ServiceOptions {
  serverUrl: string;
  agentKey: string;

  /**
   * The agent's own id, registered and stored by the caller via the
   * `agents/register` HTTP flow. The empty `network/connect` HelloOk carries no
   * identity back, so `ownAgentId` (isFromMe, the `~/.moltzap/<agentId>` socket
   * path, status, trace records) sources from here. Optional: a caller that has
   * not yet registered leaves it unset and `ownAgentId` is `undefined` until it
   * registers — the same pre-identity state the old HelloOk-sourced id had
   * before the handshake completed.
   */
  agentId?: string;
}

type NotificationHandler<T> = (data: T) => void;
type NotificationDispatcher = (
  notification: DecodedNotification<AnyNotificationDefinition>,
) => void;

interface ServiceHandlerPayloads {
  readonly message: { readonly taskId: TaskId; readonly message: Message };

  /**
   * The "raw notification" surface receives the wire decoder's
   * `DecodedNotification&lt;AnyNotificationDefinition>` union — known methods carry the
   * descriptor and a raw `params: unknown` payload (validation hasn't
   * happened yet); unknown methods carry no descriptor at all.
   * Subscribers that want validated payloads register specific typed
   * `on(...)` handlers (e.g. `conversationArchived`) which run behind
   * the typed-bridge lift in `handleNotification`.
   */
  readonly rawNotification: DecodedNotification<AnyNotificationDefinition>;
  readonly disconnect: void;
  readonly reconnect: HelloOk;
  readonly conversationArchived: TaskConversationArchivedNotification;
  readonly conversationUnarchived: TaskConversationUnarchivedNotification;
  readonly dispatchRelease: NotificationParamsOf<typeof DispatchRelease>;
  readonly dispatchesConsumed: NotificationParamsOf<typeof DispatchesConsumed>;
  readonly dispatchesExpired: NotificationParamsOf<typeof DispatchesExpired>;
}

type ServiceHandlerName = keyof ServiceHandlerPayloads;

/** Full message from another conversation, used by peekFullMessages(). */
export interface CrossConvMessage {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  senderId: string;
  text: string;
  timestamp: string;
}

/**
 * Per-conversation message cap. Older messages are evicted FIFO; the
 * on-disk history remains the source of truth. Sized for typical CLI
 * display windows — `conversations get` shows at most a few hundred.
 */
const MAX_MESSAGES_PER_CONV = 1000;

/**
 * Per-conversation dedup window. Inbound messageIds are tracked in a
 * Set bounded to this size; once full, the insertion-ordered oldest
 * entry is evicted to make room. 1000 × 36 bytes per UUID ≈ 36 KB per
 * conversation — bounded and negligible for the expected conversation count.
 */
const DEDUP_WINDOW_PER_CONV = 1000;

/**
 * Invoke every handler with `arg`, isolating throws so one bad handler
 * doesn't abort the remaining fanout.
 */
function fanout<T>(
  handlers: ReadonlyArray<NotificationHandler<T>>,
  arg: T,
): void {
  for (const h of handlers) {
    try {
      h(arg);
    } catch (err) {
      Effect.runFork(Effect.logError("notification handler threw", err));
    }
  }
}

/**
 * Stateful MoltZap client that manages connection, conversation tracking,
 * agent name resolution, and cross-conversation context generation.
 *
 * API contract: **every fallible method returns `Effect`.** No `*Async`
 * Promise siblings — async/await consumers run the Effect at the edge
 * with `Effect.runPromise`. Keep this class Effect-only so downstream
 * callers compose failures and cancellation explicitly. (Phase -1
 * vendored the legacy `@moltzap/app-sdk` Promise-shaped wrapper out
 * to arena; consumers wanting Promise wrappers maintain their own.)
 */
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
          notification.params as NotificationParamsOf<
            typeof DispatchesConsumed
          >,
        ),
    ],
    [
      DispatchesExpired,
      (notification) =>
        fanout(
          this.handlers.dispatchesExpired,
          notification.params as NotificationParamsOf<typeof DispatchesExpired>,
        ),
    ],
  ]);

  private _ownAgentId: string | undefined;

  constructor(private opts: ServiceOptions) {
    // The empty HelloOk carries no identity; `ownAgentId` is the client's
    // registered/stored id, available before the handshake.
    this._ownAgentId = opts.agentId;
  }

  get connected(): boolean {
    return this._connected;
  }

  get ownAgentId(): string | undefined {
    return this._ownAgentId;
  }

  /** Effect-native: compose via `yield*` or bridge at the edge via `Effect.runPromise`. */
  connect(): Effect.Effect<HelloOk, ServiceRpcError> {
    return Effect.gen(this, function* () {
      const client = new MoltZapAgentClient({
        serverUrl: this.opts.serverUrl,
        agentKey: this.opts.agentKey,
        // Spec #222 OQ-6: arg required. The body doesn't branch on
        // close metadata today; signature kept explicit so a future
        // disconnect-handler chain can plumb code/reason through.
        onDisconnect: () => {
          this._connected = false;
          fanout(this.handlers.disconnect, undefined);
        },
        onReconnect: (helloOk) => {
          this._connected = true;
          fanout(this.handlers.reconnect, helloOk);
        },
      });
      this.client = client;

      // Spec #596 / Spec B Goal #8: the legacy `subscribe({}, handler)` site
      // is replaced by `subscribeAll().pipe(Stream.runForEach, …)` forked
      // into a service-owned scope. The Stream is materialized BEFORE
      // `connect()` so subscriptions are registered with the registry
      // pre-handshake (pre-connect legality, preserved invariant).
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
          Effect.sync(() => this.handleNotification(notification)),
        ),
        Effect.catchAll((cause) =>
          Effect.logWarning(
            "MoltZapService notification fan-out terminated",
            cause,
          ),
        ),
        Effect.asVoid,
      );
      yield* Effect.forkIn(fanoutEffect, serviceScope);

      const helloOk = yield* client.connect();
      this._connected = true;
      return helloOk;
    });
  }

  /**
   * Tear down the service. `close()` is sync because it fans out to the
   * socket server, Refs, and the ws-client. Effectful network/filesystem
   * cleanup is forked at the edge so existing callers still get immediate
   * shutdown.
   */
  close(): void {
    this._connected = false;
    Effect.runFork(this.stopSocketServer());
    // Spec #596 / Spec B §"4.2 service.ts": close the service-owned scope
    // BEFORE the client. Closing the scope interrupts the
    // `subscribeAll().pipe(Stream.runForEach, …)` fiber; the client's
    // `close()` then closes the registry which fires `onClose` on every
    // live subscription's Stream — but since our consumer fiber has
    // already been interrupted, the typed-error delivery is to a
    // terminated consumer (no-op, idempotent).
    // Order: close the service-scope FIRST (interrupting the
    // `subscribeAll → runForEach` fiber), THEN close the ws-client.
    // zipRight chains the two Effects sequentially inside a single
    // fork so the ordering is honoured deterministically.
    const scopeToClose = this.serviceScope;
    const clientToClose = this.client;
    this.serviceScope = null;
    this.client = null;
    Effect.runFork(composeServiceTeardown(scopeToClose, clientToClose));
    Effect.runSync(
      Effect.all([
        Ref.set(this.conversationsRef, HashMap.empty()),
        Ref.set(this.messagesRef, HashMap.empty()),
        Ref.set(this.agentNamesRef, HashMap.empty()),
        Ref.set(this.agentConversationCacheRef, HashMap.empty()),
        Ref.set(this.lastNotifiedRef, HashMap.empty()),
        Ref.set(this.lastReadRef, HashMap.empty()),
      ]),
    );
    this.archivedConversationIds.clear();
    this.seenMessageIds.clear();
    // Handlers are preserved across close()/connect() cycles. MoltZapChannelCore
    // subscribes once in its constructor; clearing handlers here would silently
    // drop inbound/reconnect dispatch on any subsequent reconnect of the same
    // service instance.
  }

  // --- Socket Server ---

  private socketServerScope: Scope.CloseableScope | null = null;
  private activeSocketPath: string | null = null;

  /** Default socket path for CLI discovery. Per-instance path uses agentId. */
  static readonly SOCKET_PATH = getMoltZapServiceSocketPath();

  /**
   * `agentId` is a server-assigned string. Treat it as untrusted: if a
   * compromised or malicious server returns an id containing `..` or a
   * path separator, a naive `path.join(... , agentId)` escapes `~/.moltzap`.
   * Reject anything that isn't a safe identifier.
   */
  private static safeAgentIdSegment(id: string): string {
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : "default";
  }

  /** Per-instance socket path based on connected agentId. */
  get socketPath(): string {
    const id = MoltZapService.safeAgentIdSegment(this.ownAgentId ?? "default");
    return getMoltZapAgentServiceSocketPath(id);
  }

  startSocketServer(): Effect.Effect<void, unknown, never> {
    return Effect.gen(this, function* () {
      const previous = this.resetSocketServerState();
      yield* stopLocalSocketServer({
        socketScope: previous.socketScope,
        socketPath: previous.sockPath,
        defaultSocketPath: MoltZapService.SOCKET_PATH,
      });
      const running = yield* startLocalSocketServer({
        socketPath: this.socketPath,
        defaultSocketPath: MoltZapService.SOCKET_PATH,
        handleRequest: (method, params) =>
          this.handleSocketRequestEffect(method, params),
      });
      this.socketServerScope = running.socketScope;
      this.activeSocketPath = running.socketPath;
    }).pipe(Effect.withSpan("MoltZapService.startSocketServer"));
  }

  private resetSocketServerState(): {
    readonly socketScope: Scope.CloseableScope | null;
    readonly sockPath: string;
  } {
    const socketScope = this.socketServerScope;
    this.socketServerScope = null;
    const sockPath = this.activeSocketPath ?? this.socketPath;
    this.activeSocketPath = null;
    return { socketScope, sockPath };
  }

  private stopSocketServer(): Effect.Effect<void, never> {
    const { socketScope, sockPath } = this.resetSocketServerState();
    return stopLocalSocketServer({
      socketScope,
      socketPath: sockPath,
      defaultSocketPath: MoltZapService.SOCKET_PATH,
    }).pipe(Effect.withSpan("MoltZapService.stopSocketServer"));
  }

  private handleSocketRequestEffect(
    method: string,
    params: LocalDaemonParams,
  ): Effect.Effect<
    unknown,
    HistoryRequestInputError | ServiceInputError | ServiceRpcError
  > {
    return Effect.suspend(
      (): Effect.Effect<
        unknown,
        HistoryRequestInputError | ServiceInputError | ServiceRpcError
      > => {
        switch (method) {
          case LocalServiceCommands.Ping:
            return Effect.succeed({ ok: true, agentId: this.ownAgentId });

          case LocalServiceCommands.Status:
            return Effect.succeed({
              agentId: this.ownAgentId,
              connected: this._connected,
              conversations: this.getConversations().length,
            });

          case LocalServiceCommands.History:
            return this.handleHistoryRequest(params);

          default: {
            const definition = serverRpcMethods.find(
              (d): d is AnyServerRpcDefinition => d.name === method,
            );
            if (
              definition === undefined ||
              !definition.validateParams(params)
            ) {
              return Effect.fail(
                new ServiceInputError({
                  message: `unknown or invalid RPC method: ${method}`,
                }),
              );
            }
            return this.sendRpc(
              definition,
              params as ParamsOf<typeof definition>,
            );
          }
        }
      },
    );
  }

  private handleHistoryRequest(
    params: Record<string, unknown>,
  ): Effect.Effect<
    HistoryResponse,
    HistoryRequestInputError | ServiceRpcError
  > {
    return Effect.gen(this, function* () {
      const request = yield* decodeHistoryRequest(params);
      const result = yield* this.sendRpc(MessagesList, {
        taskId: request.taskId as TaskId,
        conversationId: request.conversationId as ConversationId,
        limit: request.limit,
      });
      const convMeta = yield* this.loadHistorySupportData(
        request.conversationId,
        result.messages,
      );
      const agentNames = yield* Ref.get(this.agentNamesRef);
      const lastReadMap = yield* Ref.get(this.lastReadRef);
      const lastReadIds = lastReadIdsForSession(lastReadMap, request);
      const messages = result.messages.map((message) =>
        formatHistoryMessage(message, {
          agentNames,
          ownAgentId: this.ownAgentId,
          lastReadIds,
          hasSessionKey: request.sessionKey !== undefined,
        }),
      );
      yield* this.advanceHistoryLastRead(request, result.messages);
      return {
        messages,
        hasMore: result.hasMore,
        conversationMeta: convMeta,
        newCount: messages.filter((message) => message.isNew).length,
      };
    });
  }

  private loadHistorySupportData(
    convId: string,
    messages: ReadonlyArray<Message>,
  ) {
    return Effect.gen(this, function* () {
      const [, convMeta] = yield* Effect.all(
        [
          this.refreshHistoryAgentNames(messages),
          this.fetchHistoryConversationMeta(convId),
        ],
        {
          concurrency: HISTORY_LOOKUP_CONCURRENCY,
        },
      );
      return convMeta;
    });
  }

  private refreshHistoryAgentNames(
    messages: ReadonlyArray<Message>,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const knownNames = yield* Ref.get(this.agentNamesRef);
      const unknownAgentIds = [
        ...new Set(messages.map((message) => message.senderId)),
      ].filter((id) => !HashMap.has(knownNames, id));
      if (unknownAgentIds.length === 0) return;
      yield* this.sendRpc(AgentsLookup, { agentIds: unknownAgentIds }).pipe(
        Effect.tap((result) =>
          Ref.update(this.agentNamesRef, (names) => {
            let next = names;
            for (const agent of result.agents) {
              next = HashMap.set(next, agent.id, agent.name);
            }
            return next;
          }),
        ),
        Effect.asVoid,
        Effect.catchAll(() => Effect.void),
      );
    });
  }

  private fetchHistoryConversationMeta(convId: string) {
    // Spec D3 D10: ConversationsGet retires; client filters
    // TaskConversationList output for the matching conversation id.
    return this.sendRpc(TaskConversationList, {}).pipe(
      Effect.map((result) => {
        const hit = result.items.find(
          (item) => item.conversation.id === (convId as ConversationId),
        );
        return hit?.conversation;
      }),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
  }

  private advanceHistoryLastRead(
    request: HistoryRequest,
    messages: ReadonlyArray<Message>,
  ): Effect.Effect<void> {
    if (request.sessionKey === undefined || messages.length === 0) {
      return Effect.void;
    }
    const { conversationId, sessionKey } = request;
    return Ref.update(this.lastReadRef, (outer) => {
      const perSession = getOr(outer, sessionKey, () =>
        HashMap.empty<string, ReadonlySet<string>>(),
      );
      const existing = getOr(
        perSession,
        conversationId,
        () => new Set<string>() as ReadonlySet<string>,
      );
      if (messages.every((message) => existing.has(message.id))) return outer;
      const nextSet = new Set(existing);
      for (const message of messages) {
        nextSet.add(message.id);
      }
      return HashMap.set(
        outer,
        sessionKey,
        HashMap.set(perSession, conversationId, nextSet),
      );
    });
  }

  // --- Conversations ---

  getConversation(convId: string): ConversationMeta | undefined {
    return Option.getOrUndefined(
      HashMap.get(snapshot(this.conversationsRef), convId),
    );
  }

  isConversationArchived(convId: string): boolean {
    return this.archivedConversationIds.has(convId);
  }

  getConversations(): ConversationMeta[] {
    return [...HashMap.values(snapshot(this.conversationsRef))];
  }

  // --- Messages ---

  getHistory(convId: string, limit?: number): Message[] {
    const msgs = getOr(
      snapshot(this.messagesRef),
      convId,
      () => [] as ReadonlyArray<Message>,
    );
    return limit ? msgs.slice(-limit) : [...msgs];
  }

  // --- Agent Names ---

  getAgentName(agentId: string): string | undefined {
    return Option.getOrUndefined(
      HashMap.get(snapshot(this.agentNamesRef), agentId),
    );
  }

  /**
   * Cache-first agent-name lookup. Never fails: falls back to `agentId`
   * when the RPC errors or the server has no record. The error path logs
   * so ops can see repeated lookup failures; the empty-response path is
   * silent (a cold agent is an expected transient state).
   */
  resolveAgentName(agentId: string): Effect.Effect<string, never> {
    return Effect.gen(this, function* () {
      const cached = Option.getOrUndefined(
        HashMap.get(snapshot(this.agentNamesRef), agentId),
      );
      if (cached !== undefined) return cached;

      return yield* this.sendRpc(AgentsLookup, {
        agentIds: [agentId],
      }).pipe(
        Effect.flatMap((result) => {
          const agent = result.agents[0];
          if (!agent) return Effect.succeed(agentId);
          return Ref.update(this.agentNamesRef, (names) =>
            HashMap.set(names, agentId, agent.name),
          ).pipe(Effect.as(agent.name));
        }),
        Effect.catchAll((err) =>
          Effect.logWarning(
            "agents/lookup failed; falling back to agentId",
          ).pipe(
            Effect.annotateLogs({ agentId, err: String(err) }),
            Effect.as(agentId),
          ),
        ),
      );
    });
  }

  // --- Messaging ---

  /**
   * Send a text message into a conversation.
   *
   * ```mermaid
   * sequenceDiagram
   *   participant caller
   *   participant svc as MoltZapService
   *   participant ws as MoltZapAgentClient
   *   participant server
   *
   *   caller->>svc: send(convId, text, opts?)
   *   alt conversation is archived
   *     svc-->>caller: fail(RpcServerError ConversationArchived)
   *   else
   *     svc->>ws: sendRpc(MessagesSend, params)
   *     Note over ws: stateRef None → fail NotConnectedError<br>otherwise allocate JsonRpcId, encode frame
   *     ws->>server: {jsonrpc, method messages/send, id, params}
   *     Note over ws: Deferred raced against 30s timeout
   *     server-->>ws: {result, id} or {error, id}
   *     Note over ws: reader fiber decodes, resolves the Deferred
   *     ws-->>svc: result or RpcServerError or RpcTimeoutError
   *     svc-->>caller: Effect.void
   *   end
   * ```
   *
   * `opts.dispatchLeaseId` (when set) is forwarded verbatim in the
   * params frame. The server marks the lease consumed, blocking the
   * TM's timeout sweep. `MoltZapChannelCore.sendReply` forwards
   * `leaseIdInFlight` automatically when the caller omits it.
   */
  send(
    taskId: TaskId,
    conversationId: ConversationId,
    text: string,
    opts?: { replyTo?: MessageId; dispatchLeaseId?: LeaseId },
  ): Effect.Effect<void, ServiceRpcError> {
    if (this.isConversationArchived(conversationId)) {
      return Effect.fail(
        new RpcServerError({
          code: ConversationArchivedError.code,
          message: "Conversation is archived",
        }),
      );
    }
    return Effect.asVoid(
      this.sendRpc(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text }],
        ...(opts?.replyTo !== undefined ? { replyToId: opts.replyTo } : {}),
        ...(opts?.dispatchLeaseId !== undefined
          ? { dispatchLeaseId: opts.dispatchLeaseId }
          : {}),
      }),
    );
  }

  /**
   * Issue `dispatch/request`. The server returns the ack
   * `{leaseId, dispatchId}` immediately; the recipient observes the
   * verdict asynchronously via the `dispatchRelease` event.
   */
  requestDispatch(
    params: ParamsOf<typeof DispatchRequest>,
  ): Effect.Effect<ResultOf<typeof DispatchRequest>, ServiceRpcError> {
    return this.sendRpc(DispatchRequest, params);
  }

  /**
   * Issue `dispatches/get`. Moderator-only — calls from non-moderator
   * connections fail with a typed wire error. The server enforces the
   * binding tuple recorded at lease-mint time.
   */
  dispatchesGet(params: {
    readonly dispatchId: DispatchId;
  }): Effect.Effect<ResultOf<typeof DispatchesGet>, ServiceRpcError> {
    return this.sendRpc(DispatchesGet, params);
  }

  sendToAgent(
    agentName: string,
    text: string,
    opts?: { replyTo?: MessageId },
  ): Effect.Effect<void, ServiceRpcError | AgentNotFoundError> {
    return Effect.gen(this, function* () {
      const cache = yield* Ref.get(this.agentConversationCacheRef);
      let entry = Option.getOrUndefined(HashMap.get(cache, agentName));
      if (entry === undefined) {
        const lookupResult = yield* this.sendRpc(AgentsLookupByName, {
          names: [agentName],
        });
        const agent = lookupResult.agents[0];
        if (!agent) {
          return yield* Effect.fail(new AgentNotFoundError({ agentName }));
        }
        const createResult = yield* this.sendRpc(TaskRequest, {
          appId: DEFAULT_APP_ID,
          invitedAgentIds: [agent.id as AgentId],
          initialConversation: { participants: [agent.id as AgentId] },
        });
        // `conversation: null` is the documented dedup-hit shape under
        // `DEFAULT_APP_ID`. Resolve the reusable conversation under the
        // returned task; if none exists (task closed / all archived),
        // fail rather than die.
        const conversationId =
          createResult.conversation !== null
            ? createResult.conversation.id
            : yield* this.resolveReusableConversationId(
                createResult.task.id,
                agentName,
              );
        entry = { taskId: createResult.task.id, conversationId };
        const cached = entry;
        yield* Ref.update(this.agentConversationCacheRef, (m) =>
          HashMap.set(m, agentName, cached),
        );
      }
      yield* this.send(entry.taskId, entry.conversationId, text, opts);
    });
  }

  private resolveReusableConversationId(
    taskId: TaskId,
    agentName: string,
  ): Effect.Effect<ConversationId, ServiceRpcError | AgentNotFoundError> {
    return Effect.gen(this, function* () {
      let cursor: string | undefined = undefined;
      for (let page = 0; page < SEND_TO_AGENT_LOOKUP_MAX_PAGES; page++) {
        const params: { limit: number; cursor?: string } = {
          limit: SEND_TO_AGENT_LOOKUP_PAGE_SIZE,
        };
        if (cursor !== undefined) params.cursor = cursor;
        const result = yield* this.sendRpc(TaskConversationList, params);
        const hit = result.items.find(
          (item) =>
            item.taskId === taskId &&
            item.conversation.archivedAt === undefined,
        );
        if (hit !== undefined) return hit.conversation.id;
        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
      }
      return yield* Effect.fail(new AgentNotFoundError({ agentName }));
    });
  }

  // --- Cross-Conversation Context ---

  /**
   * Generate a system reminder with updates from other conversations.
   * Each conversation has its own view of what's "new" — markers are tracked
   * per viewing conversation and advanced after notification.
   */
  getContext(currentConvId: string, opts?: ContextOptions): string | null {
    const contextOptions = opts ?? {};
    const { entries, commit } = this.peekContextEntries(
      currentConvId,
      contextOptions,
    );
    if (entries.length === 0) return null;
    commit();
    return formatCrossConversationBlock(entries, {
      header: `Recent updates (you are in conv:${currentConvId}):`,
    });
  }

  /**
   * Return recent activity in other conversations without advancing any state.
   * Call `commit()` on the result to mark the returned messages as seen so
   * subsequent peeks return only what's new. A caller that reads without
   * committing can re-peek idempotently.
   */
  peekContextEntries(
    currentConvId: string,
    opts?: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void } {
    const maxConvs =
      opts?.maxConversations ?? DEFAULT_MAX_CONTEXT_CONVERSATIONS;
    const maxMsgsPerConv =
      opts?.maxMessagesPerConv ?? DEFAULT_MAX_MESSAGES_PER_CONVERSATION;
    const state = this.readCrossConvState(currentConvId);
    const candidates = this.collectContextCandidates(state, currentConvId);
    const { entries, pendingAdvances } = buildContextEntries(
      candidates.slice(0, maxConvs),
      state,
      maxMsgsPerConv,
    );

    return {
      entries,
      commit: () => this.advanceLastNotified(currentConvId, pendingAdvances),
    };
  }

  /**
   * Return all new messages from all other conversations as full transcripts,
   * sorted chronologically. Uses the same lastNotified markers as
   * peekContextEntries. Call commit() to advance markers.
   */
  peekFullMessages(currentConvId: string): {
    messages: CrossConvMessage[];
    commit: () => void;
  } {
    const { messagesMap, conversationsMap, agentNamesMap, viewMarkers } =
      this.readCrossConvState(currentConvId);

    const allMessages: CrossConvMessage[] = [];
    const pendingAdvances: Array<[string, string]> = [];

    for (const [convId, newMsgs] of this.iterNewMessagesByConv(
      messagesMap,
      viewMarkers,
      currentConvId,
    )) {
      const convName = Option.getOrUndefined(
        HashMap.get(conversationsMap, convId),
      )?.name;

      for (const m of newMsgs) {
        allMessages.push({
          conversationId: convId,
          conversationName: convName,
          senderName: getOr(agentNamesMap, m.senderId, () => m.senderId),
          senderId: m.senderId,
          text: m.parts.map(renderPart).join(" "),
          timestamp: m.createdAt,
        });
      }

      pendingAdvances.push([convId, newMsgs[newMsgs.length - 1]!.id]);
    }

    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      messages: allMessages,
      commit: () => this.advanceLastNotified(currentConvId, pendingAdvances),
    };
  }

  private readCrossConvState(currentConvId: string): CrossConvState {
    const lastNotifiedMap = snapshot(this.lastNotifiedRef);
    return {
      messagesMap: snapshot(this.messagesRef),
      conversationsMap: snapshot(this.conversationsRef),
      agentNamesMap: snapshot(this.agentNamesRef),
      viewMarkers: getOr(lastNotifiedMap, currentConvId, () =>
        HashMap.empty<string, string>(),
      ),
    };
  }

  private collectContextCandidates(
    state: CrossConvState,
    currentConvId: string,
  ): ContextCandidate[] {
    const candidates: ContextCandidate[] = [];
    for (const [convId, newMsgs] of this.iterNewMessagesByConv(
      state.messagesMap,
      state.viewMarkers,
      currentConvId,
    )) {
      candidates.push(makeContextCandidate(convId, newMsgs));
    }
    candidates.sort((a, b) => b.lastTs - a.lastTs);
    return candidates;
  }

  private *iterNewMessagesByConv(
    messagesMap: HashMap.HashMap<string, ReadonlyArray<Message>>,
    viewMarkers: HashMap.HashMap<string, string>,
    currentConvId: string,
  ): Iterable<[string, ReadonlyArray<Message>]> {
    for (const [convId, msgs] of messagesMap) {
      const newMsgs = newMessagesForConversation(
        convId,
        msgs,
        viewMarkers,
        currentConvId,
      );
      if (newMsgs.length > 0) yield [convId, newMsgs];
    }
  }

  private advanceLastNotified(
    currentConvId: string,
    pendingAdvances: ReadonlyArray<readonly [string, string]>,
  ): void {
    if (pendingAdvances.length === 0) return;
    Effect.runSync(
      Ref.update(this.lastNotifiedRef, (outer) => {
        let markers = getOr(outer, currentConvId, () =>
          HashMap.empty<string, string>(),
        );
        for (const [convId, msgId] of pendingAdvances) {
          markers = HashMap.set(markers, convId, msgId);
        }
        return HashMap.set(outer, currentConvId, markers);
      }),
    );
  }

  // --- Notifications ---

  on<K extends ServiceHandlerName>(
    notification: K,
    handler: NotificationHandler<ServiceHandlerPayloads[K]>,
  ): void {
    this.handlers[notification].push(handler);
  }

  // --- RPC passthrough ---

  sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ServiceRpcError> {
    return Effect.suspend(() => {
      if (!this.client) {
        return Effect.fail(new NotConnectedError({ message: "Not connected" }));
      }
      return this.client.sendRpc(definition, params, opts);
    });
  }

  // --- Internals ---

  protected handleNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    this.recordNotificationTrace(notification);
    fanout(this.handlers.rawNotification, notification);
    this.dispatchTypedNotification(notification);
  }

  private recordNotificationTrace(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    Effect.runFork(
      appendClientEventTrace(
        notificationTraceRecord(notification, this._ownAgentId),
      ),
    );
  }

  private dispatchTypedNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    const dispatch = this.notificationDispatchers.get(notification.definition);
    if (dispatch === undefined) {
      return;
    }
    dispatch(notification);
  }

  /**
   * Record `messageId` in the per-conversation dedup window. Returns
   * `true` when the id is new (caller proceeds), `false` when the id is
   * a duplicate within the window (caller drops). On a new id, evicts
   * the oldest entry if the window is full.
   *
   * Bound to the live `messages/received` notification path: a single
   * server-side broadcast that surfaces the same id twice (network
   * replay, dual subscription) is suppressed to one
   * `on("message", ...)` event. `messages/list` returns raw history
   * unfiltered; consumers that combine both feeds dedup themselves.
   */
  private recordMessageIdIfNew(
    convId: ConversationId,
    msgId: MessageId,
  ): boolean {
    let dedupSet = this.seenMessageIds.get(convId);
    if (dedupSet === undefined) {
      dedupSet = new Set<MessageId>();
      this.seenMessageIds.set(convId, dedupSet);
    }
    if (dedupSet.has(msgId)) {
      return false;
    }
    if (dedupSet.size >= DEDUP_WINDOW_PER_CONV) {
      // size >= 1 guaranteed by the guard above; next().value is defined.
      dedupSet.delete(dedupSet.keys().next().value as MessageId);
    }
    dedupSet.add(msgId);
    return true;
  }

  private handleMessageReceivedNotification(
    notification: MessageReceivedNotification,
  ): void {
    const msg = notification.message;
    const convId = msg.conversationId;

    if (!this.recordMessageIdIfNew(convId, msg.id)) {
      return;
    }

    this.storeMessage(msg);
    // Name resolution is driven lazily by channel-core's serialized consumer
    // via resolveAgentName(), which populates agentNamesRef on first miss and
    // hits the cache on every subsequent message.
    if (msg.senderId !== this._ownAgentId) {
      fanout(this.handlers.message, {
        taskId: notification.taskId,
        message: msg,
      });
    }
  }

  private handleConversationCreatedNotification(
    notification: TaskConversationCreatedNotification,
  ): void {
    const { conversationId, name, participants } = notification;
    this.archivedConversationIds.delete(conversationId);
    Effect.runSync(
      Ref.update(this.conversationsRef, (m) => {
        const inferredType: "dm" | "group" =
          participants.length === 1 ? "dm" : "group";
        return HashMap.set(m, conversationId, {
          id: conversationId,
          type: inferredType,
          participants: participants.map((p) => `agent:${p}`),
          ...(name !== undefined ? { name } : {}),
        });
      }),
    );
  }

  private handleConversationArchivedNotification(
    notification: TaskConversationArchivedNotification,
  ): void {
    this.markConversationArchived(notification.conversationId);
    fanout(this.handlers.conversationArchived, notification);
  }

  private handleConversationUnarchivedNotification(
    notification: TaskConversationUnarchivedNotification,
  ): void {
    this.archivedConversationIds.delete(notification.conversationId);
    fanout(this.handlers.conversationUnarchived, notification);
  }

  private markConversationArchived(conversationId: ConversationId): void {
    this.seenMessageIds.delete(conversationId);
    this.archivedConversationIds.add(conversationId);
    Effect.runSync(
      Effect.all([
        Ref.update(this.conversationsRef, (m) =>
          HashMap.remove(m, conversationId),
        ),
        Ref.update(this.messagesRef, (m) => HashMap.remove(m, conversationId)),
        Ref.update(this.agentConversationCacheRef, (m) =>
          purgeAgentCacheEntries(m, conversationId),
        ),
        Ref.update(this.lastNotifiedRef, (outer) =>
          purgeLastNotified(outer, conversationId),
        ),
        Ref.update(this.lastReadRef, (outer) =>
          purgeLastRead(outer, conversationId),
        ),
      ]),
    );
  }

  private storeMessage(msg: Message): void {
    Effect.runSync(
      Ref.update(this.messagesRef, (m) => {
        const existing = getOr(
          m,
          msg.conversationId,
          () => [] as ReadonlyArray<Message>,
        );
        const appended = [...existing, msg];
        const capped =
          appended.length > MAX_MESSAGES_PER_CONV
            ? appended.slice(-MAX_MESSAGES_PER_CONV)
            : appended;
        return HashMap.set(m, msg.conversationId, capped);
      }),
    );
  }
}
