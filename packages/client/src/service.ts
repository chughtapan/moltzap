import {
  agentId as AgentIdSchema,
  AgentNotFoundError,
  agentsList,
  type AgentCard,
  type AgentId,
} from "@moltzap/protocol/identity";
import type { HelloOk } from "@moltzap/protocol/network";
import type {
  AnyAgentCallableRpcDefinition,
  AnyNotificationDefinition,
  agentCallableGroup,
} from "@moltzap/protocol/socket/catalog";
import type {
  ClientDefinitionPayload,
  ClientDefinitionSuccess,
} from "@moltzap/protocol/socket";
import {
  agentConversationCreate,
  type ConversationCreatedNotification,
  conversationCreatedNotificationDefinition,
  conversationList,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol/conversation";
import {
  type Message,
  type MessageReceivedNotification,
  messageReceivedNotificationDefinition,
  messagesList,
  messagesSend,
} from "@moltzap/protocol/message";
import {
  NotConnectedError,
  type RpcTimeoutError,
  isNotificationDeliveryFor,
  type NotificationDelivery,
  type ListCursor,
  type PayloadForTag,
  type ParamsOf,
  type SuccessForTag,
} from "@moltzap/protocol/rpc";
import type { RpcGroup, Rpc } from "@effect/rpc";
import { BoundedMap } from "./bounded-map.js";
import {
  Deferred,
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { MoltZapAgentClient, type RpcCallOptions } from "./agent-client.js";
import {
  loadServiceConfig,
  type MoltzapServiceConfig,
  type ServiceConfigError,
} from "./config.js";
import {
  getMoltZapAgentServiceSocketPath,
  getMoltZapServiceSocketPath,
} from "./local-paths.js";
import type { LocalDaemonHandlers } from "./local-daemon-rpc.js";
import { makeLocalDaemonHandlers } from "./service-local-daemon.js";
import {
  startLocalSocketServer,
  stopLocalSocketServer,
} from "./local-socket-server.js";
import { notificationTraceRecord } from "./notification/trace.js";
import { renderPart } from "./message-rendering.js";
import {
  formatHistoryMessage,
  type HistoryRequest,
  type HistoryResponse,
  lastReadIdsForSession,
} from "./local-history.js";
import { appendClientEventTrace } from "./service-event-trace.js";
import {
  PresentationState,
  type ConversationMeta,
  type CrossConversationEntry,
  type CrossConvMessage,
} from "./presentation/index.js";

/** Presentation value types exposed alongside MoltZapService. */
export type {
  ConversationMeta,
  CrossConversationEntry,
  CrossConvMessage,
} from "./presentation/index.js";

const CROSS_CONTEXT_TEXT_LIMIT = 120;
const HISTORY_LOOKUP_CONCURRENCY = 2;
const AGENT_LOOKUP_PAGE_SIZE = 100;
const AGENT_LOOKUP_MAX_PAGES = 20;
const decodeAgentId = Schema.decodeUnknownOption(AgentIdSchema);

/** The agent group's member `Rpc`s — the tag-keyed surface the service drives. */
type AgentCallableRpcs = RpcGroup.Rpcs<typeof agentCallableGroup>;

/** The branded wire tags the service may originate. */
type AgentCallableTag = AgentCallableRpcs["_tag"];

/**
 * Errors that can surface from the Effect-based service API: any tagged error
 * an agent-callable method declares (recovered from the group's per-method
 * error unions) plus the transport errors. Methods that fan multiple calls
 * (e.g. `sendToAgent`) surface this broad union; a single-method call narrows
 * to that method's errors at the `call` site.
 */
export type ServiceRpcError =
  | Rpc.Error<AgentCallableRpcs>
  | RpcTimeoutError
  | NotConnectedError;

const agentNotFound = (agentName: string): AgentNotFoundError =>
  new AgentNotFoundError({
    message: `Agent not found: ${agentName}`,
    data: { agentName },
  });

/** Configures context. */
export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}

/**
 * Escape `&lt;`, `>`, `&amp;` so sender content can't escape a `&lt;system-reminder>` block.
 * @param s Value supplied to the operation.
 * @returns The sanitize for system reminder result.
 */
export function sanitizeForSystemReminder(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format CrossConversationEntry[] as a `&lt;system-reminder>` block. Adapters
 * that inline context into prompt text (nanoclaw) and `MoltZapService.getContext`
 * share this formatter so sanitization and line shape stay in one place.
 * @param entries Value supplied to the operation.
 * @param opts Value supplied to the operation.
 * @param opts.header Value supplied to the operation.
 * @returns The format cross conversation block result.
 */
function formatCrossConversationBlock(
  entries: CrossConversationEntry[],
  opts: { header: string },
): string | null {
  if (entries.length === 0) {
    return null;
  }
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

function renderMessageText(message: Message): string {
  return message.parts.map(renderPart).join(" ");
}

type ServiceOptions = MoltzapServiceConfig;

type NotificationHandler<T> = (data: T) => void;
type ClientNotificationDelivery =
  NotificationDelivery<AnyNotificationDefinition>;

interface ServiceHandlerPayloads {
  readonly message: { readonly message: Message };

  /**
   * The "raw notification" surface receives the descriptor-tagged delivery
   * emitted after the native reverse RPC handler has Schema-decoded params.
   * Subscribers that want a specific payload narrow the delivery themselves
   * with `isNotificationDeliveryFor`.
   */
  readonly rawNotification: ClientNotificationDelivery;
  readonly disconnect: undefined;
}

type ServiceHandlerName = keyof ServiceHandlerPayloads;

/**
 * Per-conversation dedup window. `BoundedMap` evicts the oldest message id
 * when a new id arrives at capacity. 1000 × 36 bytes per UUID ≈ 36 KB per
 * conversation, which keeps replay protection negligible at the expected
 * conversation count.
 */
const DEDUP_WINDOW_PER_CONV = 1000;

/**
 * Invoke every handler with `arg`, isolating throws so one bad handler
 * doesn't abort the remaining fanout.
 * @param handlers Value supplied to the operation.
 * @param arg Value supplied to the operation.
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
 * callers compose failures and cancellation explicitly.
 */
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
  private readonly agentConversationCacheRef: Ref.Ref<
    HashMap.HashMap<string, ConversationId>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ConversationId>()));
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
        );
        yield* Effect.forkIn(fanoutEffect, serviceScope);

        const helloOk = yield* client.connect();
        this.connectedValue = true;
        return helloOk;
      }.bind(this),
    );
  }

  /**
   * Returns a lazy teardown effect that resolves after the service's owned
   * transports and notification scope close.
   *
   * @returns Completion of the service-owned cleanup.
   * @internal
   */
  shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => this.beginShutdown());
  }

  private beginShutdown(): Effect.Effect<void> {
    if (this.shutdownCompletion !== null) {
      return Deferred.await(this.shutdownCompletion);
    }
    const shutdownCompletion = Effect.runSync(Deferred.make<undefined>());
    this.shutdownCompletion = shutdownCompletion;
    this.connectedValue = false;
    const stopSocketServer = this.stopSocketServer();
    const scopeToClose = this.serviceScope;
    const clientToClose = this.client;
    this.serviceScope = null;
    this.client = null;
    const closeScope =
      scopeToClose === null
        ? Effect.void
        : Scope.close(scopeToClose, Exit.void);
    const closeClient =
      clientToClose === null ? Effect.void : clientToClose.close();
    Effect.runSync(
      Effect.all(
        [
          this.presentationState.reset(),
          Ref.set(this.agentConversationCacheRef, HashMap.empty()),
          Ref.set(this.lastReadRef, HashMap.empty()),
        ],
        { discard: true },
      ),
    );
    this.seenMessageIds.clear();
    // Handlers are preserved across explicit close()/connect() cycles.
    // MoltZapChannelCore subscribes once in its constructor; clearing handlers
    // here would silently drop inbound dispatch after the next connect.
    return Effect.uninterruptible(
      Effect.all(
        [stopSocketServer, closeScope.pipe(Effect.zipRight(closeClient))],
        { concurrency: 2, discard: true },
      ).pipe(
        Effect.ensuring(
          Deferred.succeed(shutdownCompletion, undefined).pipe(Effect.asVoid),
        ),
      ),
    );
  }

  /**
   * Starts service teardown for callers that use the legacy synchronous
   * lifecycle boundary.
   */
  close(): void {
    Effect.runFork(this.beginShutdown());
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
   * @param id Value supplied to the operation.
   * @returns The id result.
   */
  private static safeAgentIdSegment(id: string): string {
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : "default";
  }

  /**
   * Per-instance socket path based on connected agentId.
   * @returns The id result.
   */
  get socketPath(): string {
    const id = MoltZapService.safeAgentIdSegment(this.ownAgentId ?? "default");
    return getMoltZapAgentServiceSocketPath(id);
  }

  startSocketServer(): Effect.Effect<void, unknown> {
    return Effect.gen(
      function* (this: MoltZapService) {
        const previous = this.resetSocketServerState();
        yield* stopLocalSocketServer({
          socketScope: previous.socketScope,
          socketPath: previous.sockPath,
          defaultSocketPath: MoltZapService.SOCKET_PATH,
        });
        const running = yield* startLocalSocketServer({
          socketPath: this.socketPath,
          defaultSocketPath: MoltZapService.SOCKET_PATH,
          handlers: this.localDaemonHandlers(),
        });
        this.socketServerScope = running.socketScope;
        this.activeSocketPath = running.socketPath;
      }.bind(this),
    ).pipe(Effect.withSpan("MoltZapService.startSocketServer"));
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

  private stopSocketServer(): Effect.Effect<void> {
    const { socketScope, sockPath } = this.resetSocketServerState();
    return stopLocalSocketServer({
      socketScope,
      socketPath: sockPath,
      defaultSocketPath: MoltZapService.SOCKET_PATH,
    }).pipe(Effect.withSpan("MoltZapService.stopSocketServer"));
  }

  private localDaemonHandlers(): LocalDaemonHandlers {
    return makeLocalDaemonHandlers({
      ownAgentId: this.ownAgentIdValue,
      // A live thunk, not a snapshot: the handler table outlives connection
      // cycles, and daemon/status must report the same liveness the MCP
      // status tool reads.
      connected: () => this.connectedValue,
      conversationCount: () => this.getConversations().length,
      call: this.call.bind(this),
      handleHistoryRequest: (request) => this.handleHistoryRequest(request),
    });
  }

  private handleHistoryRequest(
    request: HistoryRequest,
  ): Effect.Effect<HistoryResponse, ServiceRpcError> {
    return Effect.gen(
      function* (this: MoltZapService) {
        const result = yield* this.call(messagesList.name, {
          conversationId: request.conversationId,
          limit: request.limit,
        });
        const convMeta = yield* this.loadHistorySupportData(
          request.conversationId,
          result.messages,
        );
        const agentNames = this.presentationState.getAgentNames();
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
          conversationMeta: convMeta,
          newCount: messages.filter((message) => message.isNew).length,
        };
      }.bind(this),
    );
  }

  private loadHistorySupportData(
    convId: ConversationId,
    messages: readonly Message[],
  ) {
    return Effect.gen(
      function* (this: MoltZapService) {
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
      }.bind(this),
    );
  }

  private refreshHistoryAgentNames(
    messages: readonly Message[],
  ): Effect.Effect<void> {
    return Effect.gen(
      function* (this: MoltZapService) {
        const unknownAgentIds = [
          ...new Set(messages.map((message) => message.senderId)),
        ].filter((id) => this.presentationState.getAgentName(id) === undefined);
        if (unknownAgentIds.length === 0) {
          return;
        }
        yield* this.cacheVisibleAgentNamesForIds(new Set(unknownAgentIds)).pipe(
          Effect.asVoid,
          Effect.catchAll(() => Effect.void),
        );
      }.bind(this),
    );
  }

  private fetchHistoryConversationMeta(convId: ConversationId) {
    // The client filters `ConversationList` output for the matching
    // conversation id (there is no per-conversation get RPC).
    return this.call(conversationList.name, {}).pipe(
      Effect.map((result) => {
        const hit = result.items.find(
          (item) => item.conversation.id === convId,
        );
        return hit?.conversation;
      }),
      Effect.orElseSucceed(() => undefined),
    );
  }

  private advanceHistoryLastRead(
    request: HistoryRequest,
    messages: readonly Message[],
  ): Effect.Effect<void> {
    if (request.sessionKey === undefined || messages.length === 0) {
      return Effect.void;
    }
    const { conversationId, sessionKey } = request;
    return Ref.update(this.lastReadRef, (outer) => {
      const perSession = Option.getOrElse(HashMap.get(outer, sessionKey), () =>
        HashMap.empty<string, ReadonlySet<string>>(),
      );
      const existing = Option.getOrElse(
        HashMap.get(perSession, conversationId),
        () =>
          /* Safe because the surrounding invariant establishes this asserted shape. */ new Set<string>() as ReadonlySet<string>,
      );
      if (messages.every((message) => existing.has(message.id))) {
        return outer;
      }
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
    return this.presentationState.getConversation(convId);
  }

  getConversations(): ConversationMeta[] {
    return this.presentationState.getConversations();
  }

  // --- Messages ---

  getHistory(convId: string, limit?: number): Message[] {
    const historyLimit = limit ?? 0;
    return this.presentationState.getHistory(convId, historyLimit);
  }

  // --- Agent Names ---

  getAgentName(agentId: string): string | undefined {
    return this.presentationState.getAgentName(agentId);
  }

  /**
   * Cache-first agent-name lookup. Never fails: falls back to `agentId`
   * when the RPC errors or the server has no record. The error path logs
   * so ops can see repeated lookup failures; the empty-response path is
   * silent (a cold agent is an expected transient state).
   * @param agentId Identifier of the agent targeted by the operation.
   * @returns The decoded d agent id.
   */
  resolveAgentName(agentId: string): Effect.Effect<string> {
    return Effect.gen(
      function* (this: MoltZapService) {
        const decodedAgentId = Option.getOrUndefined(decodeAgentId(agentId));
        if (decodedAgentId === undefined) {
          return agentId;
        }

        const cached = this.presentationState.getAgentName(agentId);
        if (cached !== undefined) {
          return cached;
        }

        return yield* this.cacheVisibleAgentNamesForIds(
          new Set([decodedAgentId]),
        ).pipe(
          Effect.map(() => {
            const resolved = this.presentationState.getAgentName(agentId);
            return resolved ?? agentId;
          }),
          Effect.catchAll((err) =>
            Effect.logWarning(
              "agent/identity/agents/list failed; falling back to agentId",
            ).pipe(
              Effect.annotateLogs({ agentId, err: String(err) }),
              Effect.as(agentId),
            ),
          ),
        );
      }.bind(this),
    );
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
   *   svc->>ws: sendRpc(MessagesSend, params)
   *   Note over ws: stateRef None → fail NotConnectedError; otherwise allocate request id, encode frame
   *   ws->>server: {jsonrpc, method agent/message/send, id, params}
   *   Note over ws: Deferred raced against 30s timeout
   *   server-->>ws: {result, id} or {error, id}
   *   Note over ws: reader fiber decodes, resolves the Deferred
   *   ws-->>svc: result or RpcServerError or RpcTimeoutError
   *   svc-->>caller: Effect.void
   * ```
   *
   * @param conversationId Value supplied to the operation.
   * @param text Text to process.
   * @returns The send result.
   */
  send(
    conversationId: ConversationId,
    text: string,
  ): Effect.Effect<void, ServiceRpcError> {
    return Effect.asVoid(
      this.call(messagesSend.name, {
        conversationId,
        parts: [{ type: "text", text }],
      }),
    );
  }

  /**
   * Send to a named agent, minting the DM conversation on first use and
   * reusing it afterwards. The per-name cache is what makes the DM stable:
   * `agent/conversation/create` mints a fresh conversation on every call.
   * @param agentName Name of the agent to reach.
   * @param text Text to process.
   * @returns The send result.
   */
  sendToAgent(
    agentName: string,
    text: string,
  ): Effect.Effect<void, ServiceRpcError | AgentNotFoundError> {
    return Effect.gen(
      function* (this: MoltZapService) {
        const cache = yield* Ref.get(this.agentConversationCacheRef);
        let conversationId = Option.getOrUndefined(
          HashMap.get(cache, agentName),
        );
        if (conversationId === undefined) {
          const agent = yield* this.findVisibleAgentByName(agentName);
          if (!agent) {
            return yield* agentNotFound(agentName);
          }
          const created = yield* this.call(agentConversationCreate.name, {
            participants: [agent.id],
          });
          conversationId = created.conversation.id;
          const cached = conversationId;
          yield* Ref.update(this.agentConversationCacheRef, (m) =>
            HashMap.set(m, agentName, cached),
          );
        }
        yield* this.send(conversationId, text);
      }.bind(this),
    );
  }

  private cacheAgentNames(agents: readonly AgentCard[]): Effect.Effect<void> {
    return this.presentationState.cacheAgentNames(agents);
  }

  private agentListParams(cursor?: ListCursor): ParamsOf<typeof agentsList> {
    return cursor === undefined
      ? { limit: AGENT_LOOKUP_PAGE_SIZE }
      : { limit: AGENT_LOOKUP_PAGE_SIZE, cursor };
  }

  private cacheVisibleAgentNamesForIds(
    agentIds: ReadonlySet<string>,
  ): Effect.Effect<void, ServiceRpcError> {
    return Effect.gen(
      function* (this: MoltZapService) {
        const missing = new Set(agentIds);
        let cursor: ListCursor | undefined = undefined;
        for (let page = 0; page < AGENT_LOOKUP_MAX_PAGES; page++) {
          const params = this.agentListParams(cursor);
          const result = yield* this.call(agentsList.name, params);
          yield* this.cacheAgentNames(result.agents);
          for (const agent of result.agents) {
            missing.delete(agent.id);
          }
          if (missing.size === 0 || result.nextCursor === undefined) {
            return;
          }
          cursor = result.nextCursor;
        }
      }.bind(this),
    );
  }

  private findVisibleAgentByName(
    agentName: string,
  ): Effect.Effect<AgentCard | undefined, ServiceRpcError> {
    return Effect.gen(
      function* (this: MoltZapService) {
        let cursor: ListCursor | undefined = undefined;
        for (let page = 0; page < AGENT_LOOKUP_MAX_PAGES; page++) {
          const params = this.agentListParams(cursor);
          const result = yield* this.call(agentsList.name, params);
          yield* this.cacheAgentNames(result.agents);
          const hit = result.agents.find((agent) => agent.name === agentName);
          if (hit !== undefined || result.nextCursor === undefined) {
            return hit;
          }
          cursor = result.nextCursor;
        }
        return undefined;
      }.bind(this),
    );
  }

  // --- Cross-Conversation Context ---

  /**
   * Generate a system reminder with updates from other conversations.
   * Each conversation has its own view of what's "new" — markers are tracked
   * per viewing conversation and advanced after notification.
   * @param currentConvId Value supplied to the operation.
   * @param opts Value supplied to the operation.
   * @returns The context options result.
   */
  getContext(currentConvId: string, opts?: ContextOptions): string | null {
    const contextOptions = opts ?? {};
    const { entries, commit } = this.peekContextEntries(
      currentConvId,
      contextOptions,
    );
    if (entries.length === 0) {
      return null;
    }
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
   * @param currentConvId Value supplied to the operation.
   * @param opts Value supplied to the operation.
   * @param opts.maxConversations Value supplied to the operation.
   * @param opts.maxMessagesPerConv Value supplied to the operation.
   * @returns The max convs result.
   */
  peekContextEntries(
    currentConvId: string,
    opts?: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void } {
    const contextOptions = opts ?? {};
    return this.presentationState.peekContextEntries(
      currentConvId,
      renderMessageText,
      contextOptions,
    );
  }

  /**
   * Return all new messages from all other conversations as full transcripts,
   * sorted chronologically. Uses the same lastNotified markers as
   * peekContextEntries. Call commit() to advance markers.
   * @param currentConvId Value supplied to the operation.
   * @returns The all messages result.
   */
  peekFullMessages(currentConvId: string): {
    messages: CrossConvMessage[];
    commit: () => void;
  } {
    return this.presentationState.peekFullMessages(
      currentConvId,
      renderMessageText,
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

  /**
   * Outbound RPC, typed per method — delegates to the agent client's typed
   * `call`. `call("agent/identity/agents/list", payload)` recovers the result and that
   * method's tagged-error union; an app-only method does not typecheck.
   * @param tag Value supplied to the operation.
   * @param payload Value supplied to the operation.
   * @param opts Value supplied to the operation.
   * @returns The client result.
   */
  call<Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, ServiceRpcError> {
    return Effect.suspend(() => {
      const client = this.client;
      if (!client) {
        return Effect.fail(new NotConnectedError({ message: "Not connected" }));
      }
      return client.call(tag, payload, opts);
    });
  }

  callDefinition<D extends AnyAgentCallableRpcDefinition>(
    definition: D,
    payload: ClientDefinitionPayload<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ClientDefinitionSuccess<D>, ServiceRpcError> {
    return Effect.suspend(() => {
      const client = this.client;
      if (!client) {
        return Effect.fail(new NotConnectedError({ message: "Not connected" }));
      }
      return client.callDefinition(definition, payload, opts);
    });
  }

  // --- Internals ---

  protected handleNotification(notification: ClientNotificationDelivery): void {
    this.recordNotificationTrace(notification);
    fanout(this.handlers.rawNotification, notification);
    this.dispatchTypedNotification(notification);
  }

  private recordNotificationTrace(
    notification: ClientNotificationDelivery,
  ): void {
    Effect.runFork(
      appendClientEventTrace(
        notificationTraceRecord(notification, this.ownAgentIdValue),
      ),
    );
  }

  private dispatchTypedNotification(
    notification: ClientNotificationDelivery,
  ): void {
    if (this.dispatchMessageNotification(notification)) {
      return;
    }
    this.dispatchConversationNotification(notification);
  }

  private dispatchMessageNotification(
    notification: ClientNotificationDelivery,
  ): boolean {
    if (
      isNotificationDeliveryFor(
        notification,
        messageReceivedNotificationDefinition,
      )
    ) {
      this.handleMessageReceivedNotification(notification.params);
      return true;
    }
    return false;
  }

  private dispatchConversationNotification(
    notification: ClientNotificationDelivery,
  ): boolean {
    if (
      isNotificationDeliveryFor(
        notification,
        conversationCreatedNotificationDefinition,
      )
    ) {
      this.handleConversationCreatedNotification(notification.params);
      return true;
    }
    return false;
  }

  /**
   * Record `messageId` in the per-conversation dedup window. Returns
   * `true` when the id is new (caller proceeds), `false` when the id is
   * a duplicate within the window (caller drops). On a new id, evicts
   * the oldest entry if the window is full.
   *
   * Bound to the live `agent/message/received` notification path: a single
   * server-side broadcast that surfaces the same id twice (network
   * replay, dual subscription) is suppressed to one
   * `on("message", ...)` event. `agent/message/list` returns raw history
   * unfiltered; consumers that combine both feeds dedup themselves.
   * @param convId Value supplied to the operation.
   * @param msgId Value supplied to the operation.
   * @returns The dedup window result.
   */
  private recordMessageIdIfNew(
    convId: ConversationId,
    msgId: MessageId,
  ): boolean {
    let dedupWindow = this.seenMessageIds.get(convId);
    if (dedupWindow === undefined) {
      dedupWindow = new BoundedMap<MessageId, true>(DEDUP_WINDOW_PER_CONV);
      this.seenMessageIds.set(convId, dedupWindow);
    }
    if (dedupWindow.has(msgId)) {
      // Replays retain their original FIFO age so repeated delivery cannot
      // keep an old id resident forever.
      return false;
    }
    dedupWindow.set(msgId, true);
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

    this.presentationState.storeMessage(msg.conversationId, msg);
    // Name resolution is driven lazily by channel-core's serialized consumer
    // via resolveAgentName(), which populates the presentation name cache on
    // first miss and hits it on every subsequent message.
    if (msg.senderId !== this.ownAgentIdValue) {
      fanout(this.handlers.message, { message: msg });
    }
  }

  private handleConversationCreatedNotification(
    notification: ConversationCreatedNotification,
  ): void {
    this.presentationState.storeConversation(notification);
  }
}
