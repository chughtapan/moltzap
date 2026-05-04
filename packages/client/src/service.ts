import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  AgentsLookup,
  AgentsLookupByName,
  type HelloOk,
  type AnyNotificationDefinition,
  agentId as toAgentId,
  AppsAuthorizeDispatch,
  bindNotificationHandler,
  ConversationsCreate,
  ConversationsGet,
  type ConversationCreatedNotification,
  type ConversationUpdatedNotification,
  conversationId as toConversationId,
  type DecodedNotification,
  defineEffectNotificationHandlers,
  defineNotificationGroup,
  type Message,
  type MessageReceivedNotification,
  type Part,
  type ConversationArchivedNotification,
  type ConversationUnarchivedNotification,
  MessageReceivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ErrorCodes,
  isDecodedNotificationInGroup,
  messageId as toMessageId,
  MessagesList,
  MessagesSend,
  NotConnectedError,
  rpcMethods,
  RpcServerError,
  RpcTimeoutError,
  type RpcDefinition,
  type ParamsOf,
  type ResultOf,
  type TSchema,
} from "@moltzap/protocol";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  HashMap,
  Match,
  Option,
  Ref,
} from "effect";
import {
  MoltZapWsClient,
  type RpcCallOptions,
  type WsClientLogger,
} from "./ws-client.js";
import { AgentNotFoundError } from "./runtime/errors.js";
import { getOr, snapshot } from "./runtime/refs.js";
import { LocalServiceCommands } from "./runtime/local-service-commands.js";
import type {
  DispatchAdmissionDecision,
  DispatchAdmissionRequest,
} from "./channel-core.js";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CROSS_CONTEXT_TEXT_LIMIT = 120;
const DEFAULT_HISTORY_LIMIT = 10;
const DEFAULT_MAX_CONTEXT_CONVERSATIONS = 5;
const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 3;
const HISTORY_LOOKUP_CONCURRENCY = 2;
const MILLISECONDS_PER_MINUTE = 60_000;
const SOCKET_FILE_MODE = 0o600;

class ServiceInputError extends Data.TaggedError("ServiceInputError")<{
  readonly message: string;
}> {}

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

function appendClientEventTrace(record: Record<string, unknown>): void {
  const dir = getClientEventLogDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const agentId =
      typeof record["agentId"] === "string" ? record["agentId"] : "unknown";
    const safeAgentId = /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : "unknown";
    fs.appendFileSync(
      path.join(dir, `client-events-${safeAgentId}.jsonl`),
      JSON.stringify(record) + "\n",
    );
  } catch (err) {
    try {
      process.stderr.write(
        `moltzap client event trace write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } catch (stderrErr) {
      void stderrErr;
    }
  }
}

/**
 * Errors that can surface from the Effect-based service API. Matches the
 * failure channel of `MoltZapWsClient.sendRpc` / `connect`.
 */
export type ServiceRpcError =
  | NotConnectedError
  | RpcTimeoutError
  | RpcServerError;

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

/** Escape `<`, `>`, `&` so sender content can't escape a `<system-reminder>` block. */
export function sanitizeForSystemReminder(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format CrossConversationEntry[] as a `<system-reminder>` block. Adapters
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
  logger?: WsClientLogger;
}

type NotificationHandler<T> = (data: T) => void;

interface ServiceHandlerPayloads {
  readonly message: Message;
  readonly rawNotification: DecodedNotification<AnyNotificationDefinition>;
  readonly disconnect: void;
  readonly reconnect: HelloOk;
  readonly conversationArchived: ConversationArchivedNotification;
  readonly conversationUnarchived: ConversationUnarchivedNotification;
}

type ServiceHandlerName = keyof ServiceHandlerPayloads;

const DISPATCH_AUTHORIZATION_RPC_TIMEOUT_MS = 900_000;

/** Full message from another conversation, used by peekFullMessages(). */
export interface CrossConvMessage {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  senderId: string;
  text: string;
  timestamp: string;
}

const renderPart: (p: Part) => string = Match.type<Part>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (t) => t.text,
    image: () => "[image]",
    file: (f) => `[file: ${f.name}]`,
  }),
);

/**
 * Per-conversation message cap. Older messages are evicted FIFO; the
 * on-disk history remains the source of truth. Sized for typical CLI
 * display windows — `conversations get` shows at most a few hundred.
 */
const MAX_MESSAGES_PER_CONV = 1000;

const serviceNotificationDefinitions = [
  MessageReceivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
] as const;

const serviceNotificationGroup = defineNotificationGroup(
  "clientService",
  serviceNotificationDefinitions,
);

/**
 * Invoke every handler with `arg`, isolating throws so one bad handler
 * doesn't abort the remaining fanout. Logs via the optional client logger.
 */
function fanout<T>(
  handlers: ReadonlyArray<NotificationHandler<T>>,
  arg: T,
  logger?: WsClientLogger,
): void {
  for (const h of handlers) {
    try {
      h(arg);
    } catch (err) {
      logger?.error("notification handler threw", err);
    }
  }
}

/**
 * Stateful MoltZap client that manages connection, conversation tracking,
 * agent name resolution, and cross-conversation context generation.
 *
 * API contract: **every fallible method returns `Effect`.** There are no
 * `*Async` Promise siblings (unlike `@moltzap/app-sdk`'s `MoltZapApp`);
 * async/await consumers run the Effect at the edge with `Effect.runPromise`.
 * `@moltzap/app-sdk` is the public app-facing surface and layers its own
 * `*Async` wrappers on top. Keep this class Effect-only so downstream
 * callers compose failures and cancellation explicitly.
 */
export class MoltZapService {
  private client: MoltZapWsClient | null = null;
  private _connected = false;

  private readonly conversationsRef: Ref.Ref<
    HashMap.HashMap<string, ConversationMeta>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ConversationMeta>()));
  private readonly messagesRef: Ref.Ref<
    HashMap.HashMap<string, ReadonlyArray<Message>>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ReadonlyArray<Message>>()));
  private readonly agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>> =
    Effect.runSync(Ref.make(HashMap.empty<string, string>()));
  private readonly agentConversationCacheRef: Ref.Ref<
    HashMap.HashMap<string, string>
  > = Effect.runSync(Ref.make(HashMap.empty<string, string>()));
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
  };
  private readonly notificationHandlers = this.createNotificationHandlers();

  private _ownAgentId: string | undefined;

  constructor(private opts: ServiceOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  get ownAgentId(): string | undefined {
    return this._ownAgentId;
  }

  /** Effect-native: compose via `yield*` or bridge at the edge via `Effect.runPromise`. */
  connect(): Effect.Effect<HelloOk, ServiceRpcError> {
    return Effect.gen(this, function* () {
      this.client = new MoltZapWsClient({
        serverUrl: this.opts.serverUrl,
        agentKey: this.opts.agentKey,
        logger: this.opts.logger,
        // Spec #222 OQ-6: arg required. The body doesn't branch on
        // close metadata today; signature kept explicit so a future
        // disconnect-handler chain can plumb code/reason through.
        onDisconnect: (close) => {
          void close;
          this._connected = false;
          fanout(this.handlers.disconnect, undefined, this.opts.logger);
        },
        onReconnect: (helloOk) => {
          this._connected = true;
          this.populateFromHello(helloOk);
          fanout(this.handlers.reconnect, helloOk, this.opts.logger);
        },
      });
      // Spec #222 OQ-4: per-notification callback is replaced by subscriptions.
      // Replacement: register a `{}` filter subscription before
      // `connect()` so every inbound notification still fans out to
      // `handleNotification`. Pre-connect registration is supported by the
      // registry.
      yield* this.client.subscribe({}, (notification) =>
        Effect.sync(() => this.handleNotification(notification)),
      );

      const helloOk = yield* this.client.connect();
      this._connected = true;
      this._ownAgentId = helloOk.agentId;
      this.populateFromHello(helloOk);
      return helloOk;
    });
  }

  /**
   * Tear down the service. `close()` is sync because it fans out to the
   * socket server, Refs, and the ws-client — the ws-client's own close
   * Effect is run via `Effect.runSync` here so the caller gets an immediate
   * shutdown the way existing code expects.
   */
  close(): void {
    this._connected = false;
    this.stopSocketServer();
    if (this.client) {
      void Effect.runPromise(this.client.close());
    }
    this.client = null;
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
    // Handlers are preserved across close()/connect() cycles. MoltZapChannelCore
    // subscribes once in its constructor; clearing handlers here would silently
    // drop inbound/reconnect dispatch on any subsequent reconnect of the same
    // service instance.
  }

  // --- Socket Server ---

  private socketServer: net.Server | null = null;
  private activeSocketPath: string | null = null;

  /** Default socket path for CLI discovery. Per-instance path uses agentId. */
  static readonly SOCKET_PATH = path.join(
    os.homedir(),
    ".moltzap",
    "service.sock",
  );

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
    return path.join(os.homedir(), ".moltzap", `service-${id}.sock`);
  }

  startSocketServer(): void {
    const sockPath = this.socketPath;
    this.activeSocketPath = sockPath;
    try {
      fs.unlinkSync(sockPath);
    } catch (err) {
      // ENOENT is the normal case (no stale socket); log everything
      // else (permission denied, EACCES) so operators can diagnose.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.opts.logger?.warn("unlink existing socket failed", err);
      }
    }
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });

    this.socketServer = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          // Fork the line-handler Effect onto the Effect runtime. Each line
          // dispatches independently; the fiber runs until it writes a
          // response or error frame back onto the socket.
          Effect.runFork(this.handleSocketLineEffect(line, conn));
        }
      });
    });
    this.socketServer.listen(sockPath, () => {
      // Owner-only permissions: the socket exposes an RPC passthrough that
      // impersonates this agent to the server, so other local users on the
      // host must not be able to connect.
      try {
        fs.chmodSync(sockPath, SOCKET_FILE_MODE);
      } catch (err) {
        this.opts.logger?.warn("chmod 0600 on socket failed", err);
      }
    });

    // Symlink default path to this instance for CLI discovery
    try {
      fs.unlinkSync(MoltZapService.SOCKET_PATH);
    } catch (err) {
      // Stale/missing default symlink is expected most of the time; log
      // at debug so real permission errors still surface.
      this.opts.logger?.info("unlink default socket symlink", err);
    }
    try {
      fs.symlinkSync(sockPath, MoltZapService.SOCKET_PATH);
    } catch (err) {
      this.opts.logger?.warn("symlink default socket failed", err);
    }
  }

  stopSocketServer(): void {
    this.socketServer?.close();
    this.socketServer = null;
    const sockPath = this.activeSocketPath ?? this.socketPath;
    this.activeSocketPath = null;
    try {
      fs.unlinkSync(sockPath);
    } catch (err) {
      this.opts.logger?.info("unlink socket path", err);
    }
    // Remove default symlink only if it points to this instance.
    try {
      const target = fs.readlinkSync(MoltZapService.SOCKET_PATH);
      if (target === sockPath) fs.unlinkSync(MoltZapService.SOCKET_PATH);
    } catch (err) {
      this.opts.logger?.info("cleanup default symlink", err);
    }
  }

  /**
   * Handle one JSON line from the unix socket as an Effect. Parses the
   * request, dispatches through `handleSocketRequestEffect`, and writes
   * either a `{result}` or `{error}` frame back onto the connection.
   * Never fails — all branches resolve into a `conn.write` side effect.
   */
  private handleSocketLineEffect(
    line: string,
    conn: net.Socket,
  ): Effect.Effect<void, never> {
    return Effect.suspend(() => {
      let req: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!isPlainRecord(parsed)) {
          return Effect.sync(() =>
            conn.write(
              JSON.stringify({
                error: "request must be a JSON object",
              }) + "\n",
            ),
          );
        }
        req = parsed;
      } catch (err) {
        return Effect.sync(() =>
          conn.write(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }) + "\n",
          ),
        );
      }
      if (typeof req.method !== "string" || !req.method) {
        return Effect.sync(() =>
          conn.write(
            JSON.stringify({
              error: "method is required and must be a string",
            }) + "\n",
          ),
        );
      }
      const params = isPlainRecord(req.params) ? req.params : {};
      return this.handleSocketRequestEffect(req.method, params).pipe(
        Effect.match({
          onSuccess: (result) => {
            conn.write(JSON.stringify({ result }) + "\n");
          },
          onFailure: (err) => {
            conn.write(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }) + "\n",
            );
          },
        }),
      );
    });
  }

  private handleSocketRequestEffect(
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, ServiceInputError | ServiceRpcError> {
    return Effect.suspend(() => {
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
          const definition = rpcMethods.find((def) => def.name === method);
          if (definition === undefined || !definition.validateParams(params)) {
            return Effect.fail(
              new ServiceInputError({
                message: `unknown or invalid RPC method: ${method}`,
              }),
            );
          }
          return this.sendRpc(definition, params);
        }
      }
    });
  }

  private handleHistoryRequest(
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, ServiceInputError | ServiceRpcError> {
    return Effect.gen(this, function* () {
      if (typeof params.conversationId !== "string" || !params.conversationId) {
        return yield* Effect.fail(
          new ServiceInputError({
            message: "conversationId is required and must be a string",
          }),
        );
      }
      if (params.limit !== undefined && typeof params.limit !== "number") {
        return yield* Effect.fail(
          new ServiceInputError({ message: "limit must be a number" }),
        );
      }
      const convId = params.conversationId;
      const limit = (params.limit as number) ?? DEFAULT_HISTORY_LIMIT;
      const sessionKey = params.sessionKey as string | undefined;
      const result = yield* this.sendRpc(MessagesList, {
        conversationId: toConversationId(convId),
        limit,
      });

      // Resolve agent names (batch) + fetch conversation metadata (concurrent)
      const knownNames = yield* Ref.get(this.agentNamesRef);
      const unknownAgentIds = [
        ...new Set(result.messages.map((m) => m.senderId)),
      ].filter((id) => !HashMap.has(knownNames, id));

      const lookupEff =
        unknownAgentIds.length > 0
          ? this.sendRpc(AgentsLookup, { agentIds: unknownAgentIds }).pipe(
              Effect.tap((res) => {
                return Ref.update(this.agentNamesRef, (names) => {
                  let next = names;
                  for (const a of res.agents) {
                    next = HashMap.set(next, a.id, a.name);
                  }
                  return next;
                });
              }),
              Effect.asVoid,
              Effect.catchAll(() => Effect.void),
            )
          : Effect.void;

      const metaEff = this.sendRpc(ConversationsGet, {
        conversationId: toConversationId(convId),
      }).pipe(
        Effect.map((res) => res.conversation),
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

      const [, convMeta] = yield* Effect.all([lookupEff, metaEff], {
        concurrency: HISTORY_LOOKUP_CONCURRENCY,
      });

      // Determine what's "new" using lastRead (not lastNotified).
      // lastNotified is advanced by getContext() (system-reminder).
      // lastRead is advanced here when the agent explicitly reads history.
      const allAgentNames = yield* Ref.get(this.agentNamesRef);
      const lastReadMap = yield* Ref.get(this.lastReadRef);
      const lastReadIds: ReadonlySet<string> = sessionKey
        ? Option.getOrElse(
            Option.flatMap(HashMap.get(lastReadMap, sessionKey), (perConv) =>
              HashMap.get(perConv, convId),
            ),
            () => new Set<string>() as ReadonlySet<string>,
          )
        : new Set<string>();

      const messages = result.messages.map((m) => {
        const text = m.parts.map(renderPart).join(" ");
        const senderName = Option.getOrElse(
          HashMap.get(allAgentNames, m.senderId),
          () => m.senderId,
        );
        return {
          id: m.id,
          senderId: m.senderId,
          senderName: m.senderId === this.ownAgentId ? "you" : senderName,
          isOwn: m.senderId === this.ownAgentId,
          text,
          createdAt: m.createdAt,
          isNew: sessionKey ? !lastReadIds.has(m.id) : false,
        };
      });

      // Advance lastRead to include all message IDs in the returned page.
      if (sessionKey && result.messages.length > 0) {
        yield* Ref.update(this.lastReadRef, (outer) => {
          const perSession = getOr(outer, sessionKey, () =>
            HashMap.empty<string, ReadonlySet<string>>(),
          );
          const existing = getOr(
            perSession,
            convId,
            () => new Set<string>() as ReadonlySet<string>,
          );
          if (result.messages.every((m) => existing.has(m.id))) return outer;
          const nextSet = new Set(existing);
          for (const m of result.messages) nextSet.add(m.id);
          return HashMap.set(
            outer,
            sessionKey,
            HashMap.set(perSession, convId, nextSet),
          );
        });
      }

      return {
        messages,
        hasMore: result.hasMore,
        conversationMeta: convMeta,
        newCount: messages.filter((m) => m.isNew).length,
      };
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

  send(
    convId: string,
    text: string,
    opts?: { replyTo?: string; dispatchLeaseId?: string },
  ): Effect.Effect<void, ServiceRpcError> {
    if (this.isConversationArchived(convId)) {
      return Effect.fail(
        new RpcServerError({
          code: ErrorCodes.ConversationArchived,
          message: "Conversation is archived",
        }),
      );
    }
    return Effect.asVoid(
      this.sendRpc(MessagesSend, {
        conversationId: toConversationId(convId),
        parts: [{ type: "text", text }],
        ...(opts?.replyTo ? { replyToId: toMessageId(opts.replyTo) } : {}),
        ...(opts?.dispatchLeaseId
          ? { dispatchLeaseId: opts.dispatchLeaseId }
          : {}),
      }),
    );
  }

  authorizeDispatch(
    request: DispatchAdmissionRequest,
  ): Effect.Effect<DispatchAdmissionDecision, ServiceRpcError> {
    return this.sendRpc(
      AppsAuthorizeDispatch,
      {
        conversationId: toConversationId(request.conversationId),
        messageId: toMessageId(request.message.id),
        senderAgentId: toAgentId(request.senderAgentId),
        parts: [...request.message.parts],
        receivedAt: request.receivedAt,
        clock: request.clock,
        pending: request.pending.map((pending) => ({
          ...pending,
          messageId: toMessageId(pending.messageId),
          conversationId: toConversationId(pending.conversationId),
          senderAgentId: toAgentId(pending.senderAgentId),
          ...(pending.parts !== undefined ? { parts: [...pending.parts] } : {}),
        })),
        attempt: request.attempt,
      },
      { timeoutMs: DISPATCH_AUTHORIZATION_RPC_TIMEOUT_MS },
    ).pipe(
      Effect.map((result) => {
        const { admission } = result;
        switch (admission.decision) {
          case "grant":
            return {
              _tag: "grant",
              ...(admission.leaseId !== undefined
                ? { leaseId: admission.leaseId }
                : {}),
              ...(admission.leaseTimeoutMs !== undefined
                ? { leaseTimeoutMs: admission.leaseTimeoutMs }
                : {}),
              ...(admission.dispatchMessageId
                ? { dispatchMessageId: admission.dispatchMessageId }
                : {}),
            };
          case "deny":
            return {
              _tag: "deny",
              ...(admission.reason !== undefined
                ? { reason: admission.reason }
                : {}),
            };
          case "hold":
            return {
              _tag: "hold",
              ...(admission.reason !== undefined
                ? { reason: admission.reason }
                : {}),
            };
        }
      }),
    );
  }

  sendToAgent(
    agentName: string,
    text: string,
    opts?: { replyTo?: string },
  ): Effect.Effect<void, ServiceRpcError | AgentNotFoundError> {
    return Effect.gen(this, function* () {
      const cache = yield* Ref.get(this.agentConversationCacheRef);
      let conversationId = Option.getOrUndefined(HashMap.get(cache, agentName));
      if (!conversationId) {
        const lookupResult = yield* this.sendRpc(AgentsLookupByName, {
          names: [agentName],
        });
        const agent = lookupResult.agents[0];
        if (!agent) {
          return yield* Effect.fail(new AgentNotFoundError({ agentName }));
        }
        const createResult = yield* this.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: toAgentId(agent.id) }],
        });
        conversationId = createResult.conversation.id;
        const newId = conversationId;
        yield* Ref.update(this.agentConversationCacheRef, (m) =>
          HashMap.set(m, agentName, newId),
        );
      }
      yield* this.send(conversationId, text, opts);
    });
  }

  // --- Cross-Conversation Context ---

  /**
   * Generate a system reminder with updates from other conversations.
   * Each conversation has its own view of what's "new" — markers are tracked
   * per viewing conversation and advanced after notification.
   */
  getContext(currentConvId: string, opts?: ContextOptions): string | null {
    const { entries, commit } = this.peekContextEntries(currentConvId, opts);
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
    const { messagesMap, conversationsMap, agentNamesMap, viewMarkers } =
      this.readCrossConvState(currentConvId);

    // Collect all candidate conversations with their last-message timestamp,
    // then sort by recency before applying `maxConvs`. HashMap iteration
    // order is hash-based (not insertion/recency), so without the sort the
    // maxConvs truncation would pick an arbitrary subset and could omit the
    // freshest conversations.
    const candidates: Array<{
      convId: string;
      newMsgs: ReadonlyArray<Message>;
      lastTs: number;
    }> = [];
    for (const [convId, newMsgs] of this.iterNewMessagesByConv(
      messagesMap,
      viewMarkers,
      currentConvId,
    )) {
      const last = newMsgs[newMsgs.length - 1]!;
      candidates.push({
        convId,
        newMsgs,
        lastTs: new Date(last.createdAt).getTime(),
      });
    }
    candidates.sort((a, b) => b.lastTs - a.lastTs);

    const entries: CrossConversationEntry[] = [];
    const pendingAdvances: Array<[string, string]> = [];

    for (const { convId, newMsgs } of candidates.slice(0, maxConvs)) {
      const reportable = newMsgs.slice(-maxMsgsPerConv);
      const last = reportable[reportable.length - 1]!;
      const senderName = getOr(
        agentNamesMap,
        last.senderId,
        () => last.senderId,
      );
      const minutesAgo = Math.max(
        0,
        Math.round(
          (Date.now() - new Date(last.createdAt).getTime()) /
            MILLISECONDS_PER_MINUTE,
        ),
      );

      entries.push({
        conversationId: convId,
        conversationName: Option.getOrUndefined(
          HashMap.get(conversationsMap, convId),
        )?.name,
        senderName,
        text: last.parts.map(renderPart).join(" "),
        minutesAgo,
        count: reportable.length,
      });

      pendingAdvances.push([convId, last.id]);
    }

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

  private readCrossConvState(currentConvId: string): {
    messagesMap: HashMap.HashMap<string, ReadonlyArray<Message>>;
    conversationsMap: HashMap.HashMap<string, ConversationMeta>;
    agentNamesMap: HashMap.HashMap<string, string>;
    viewMarkers: HashMap.HashMap<string, string>;
  } {
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

  private *iterNewMessagesByConv(
    messagesMap: HashMap.HashMap<string, ReadonlyArray<Message>>,
    viewMarkers: HashMap.HashMap<string, string>,
    currentConvId: string,
  ): Iterable<[string, ReadonlyArray<Message>]> {
    for (const [convId, msgs] of messagesMap) {
      if (convId === currentConvId || msgs.length === 0) continue;
      const lastSeenId = Option.getOrUndefined(
        HashMap.get(viewMarkers, convId),
      );
      const lastSeenIdx = lastSeenId
        ? msgs.findIndex((m) => m.id === lastSeenId)
        : -1;
      const newMsgs = msgs.slice(lastSeenIdx + 1);
      if (newMsgs.length === 0) continue;
      yield [convId, newMsgs];
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

  sendRpc<D extends RpcDefinition<string, TSchema, TSchema>>(
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

  /**
   * Fetch full conversation details (including participants) via RPC and merge
   * into the local cache. Called on ConversationCreated notifications because
   * the notification schema omits the participants list — see
   * protocol/notifications.ts.
   */
  private refreshConversationParticipants(
    conversationId: string,
  ): Effect.Effect<void, never> {
    return this.sendRpc(ConversationsGet, {
      conversationId: toConversationId(conversationId),
    }).pipe(
      Effect.tap((res) => {
        const meta: ConversationMeta = {
          id: res.conversation.id,
          type: res.conversation.type,
          participants: res.participants.map(
            (p) => `${p.participant.type}:${p.participant.id}`,
          ),
          ...(res.conversation.name !== undefined
            ? { name: res.conversation.name }
            : {}),
        };
        if (this.archivedConversationIds.has(conversationId)) {
          return Effect.void;
        }
        return Ref.update(this.conversationsRef, (m) =>
          HashMap.set(m, conversationId, meta),
        );
      }),
      Effect.asVoid,
      // Best-effort refresh. Leave the existing entry in place on failure.
      Effect.catchAll(() => Effect.void),
    );
  }

  private populateFromHello(hello: HelloOk): void {
    if (!hello.conversations) return;
    const incoming = hello.conversations;
    Effect.runSync(
      Ref.update(this.conversationsRef, (m) => {
        let next = m;
        for (const conv of incoming) {
          this.archivedConversationIds.delete(conv.id);
          next = HashMap.set(next, conv.id, {
            id: conv.id,
            type: conv.type,
            participants: (conv.participants ?? []).map(
              (p) => `${p.type}:${p.id}`,
            ),
            ...(conv.name !== undefined ? { name: conv.name } : {}),
          });
        }
        return next;
      }),
    );
  }

  protected handleNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    const params: Record<string, unknown> = isPlainRecord(notification.params)
      ? notification.params
      : {};
    const message = isPlainRecord(params["message"])
      ? params["message"]
      : undefined;
    const conversation = isPlainRecord(params["conversation"])
      ? params["conversation"]
      : undefined;
    const notificationConversationId =
      typeof params["conversationId"] === "string"
        ? params["conversationId"]
        : undefined;
    appendClientEventTrace({
      ts: new Date().toISOString(),
      agentId: this._ownAgentId ?? "unknown",
      notification: notification.method,
      messageId: message?.["id"],
      messageConversationId: message?.["conversationId"],
      messageSenderId: message?.["senderId"],
      conversationId: conversation?.["id"] ?? notificationConversationId,
      conversationName: conversation?.["name"],
    });

    fanout(this.handlers.rawNotification, notification, this.opts.logger);

    if (isDecodedNotificationInGroup(serviceNotificationGroup, notification)) {
      Effect.runSync(this.notificationHandlers.dispatch(notification));
    }
  }

  private createNotificationHandlers() {
    return defineEffectNotificationHandlers(serviceNotificationGroup, [
      bindNotificationHandler(MessageReceivedNotificationDefinition, (params) =>
        Effect.sync(() => this.handleMessageReceivedNotification(params)),
      ),
      bindNotificationHandler(
        ConversationCreatedNotificationDefinition,
        (params) =>
          Effect.sync(() => this.handleConversationCreatedNotification(params)),
      ),
      bindNotificationHandler(
        ConversationUpdatedNotificationDefinition,
        (params) =>
          Effect.sync(() => this.handleConversationUpdatedNotification(params)),
      ),
      bindNotificationHandler(
        ConversationArchivedNotificationDefinition,
        (params) =>
          Effect.sync(() => {
            this.markConversationArchived(params.conversationId);
            fanout(
              this.handlers.conversationArchived,
              params,
              this.opts.logger,
            );
          }),
      ),
      bindNotificationHandler(
        ConversationUnarchivedNotificationDefinition,
        (params) =>
          Effect.sync(() => {
            this.archivedConversationIds.delete(params.conversationId);
            fanout(
              this.handlers.conversationUnarchived,
              params,
              this.opts.logger,
            );
          }),
      ),
    ]);
  }

  private handleMessageReceivedNotification(
    notification: MessageReceivedNotification,
  ): void {
    const msg = notification.message;
    this.storeMessage(msg);
    // Name resolution is driven lazily by channel-core's serialized consumer
    // via resolveAgentName(), which populates agentNamesRef on first miss and
    // hits the cache on every subsequent message.
    if (msg.senderId !== this._ownAgentId) {
      fanout(this.handlers.message, msg, this.opts.logger);
    }
  }

  private handleConversationCreatedNotification(
    notification: ConversationCreatedNotification,
  ): void {
    this.upsertConversationNotification(notification);
    Effect.runFork(
      this.refreshConversationParticipants(notification.conversation.id),
    );
  }

  private handleConversationUpdatedNotification(
    notification: ConversationUpdatedNotification,
  ): void {
    this.upsertConversationNotification(notification);
  }

  private upsertConversationNotification(
    notification:
      | ConversationCreatedNotification
      | ConversationUpdatedNotification,
  ): void {
    const { conversation } = notification;
    this.archivedConversationIds.delete(conversation.id);
    Effect.runSync(
      Ref.update(this.conversationsRef, (m) => {
        const existing = Option.getOrUndefined(HashMap.get(m, conversation.id));
        return HashMap.set(m, conversation.id, {
          id: conversation.id,
          type: conversation.type,
          participants: existing?.participants ?? [],
          ...(conversation.name !== undefined
            ? { name: conversation.name }
            : {}),
        });
      }),
    );
  }

  private markConversationArchived(conversationId: string): void {
    this.archivedConversationIds.add(conversationId);
    Effect.runSync(
      Effect.all([
        Ref.update(this.conversationsRef, (m) =>
          HashMap.remove(m, conversationId),
        ),
        Ref.update(this.messagesRef, (m) => HashMap.remove(m, conversationId)),
        Ref.update(this.agentConversationCacheRef, (m) => {
          let next = HashMap.empty<string, string>();
          for (const [agentName, convId] of HashMap.entries(m)) {
            if (convId !== conversationId) {
              next = HashMap.set(next, agentName, convId);
            }
          }
          return next;
        }),
        Ref.update(this.lastNotifiedRef, (outer) => {
          let next = HashMap.empty<string, HashMap.HashMap<string, string>>();
          for (const [viewConvId, markers] of HashMap.entries(outer)) {
            if (viewConvId !== conversationId) {
              next = HashMap.set(
                next,
                viewConvId,
                HashMap.remove(markers, conversationId),
              );
            }
          }
          return next;
        }),
        Ref.update(this.lastReadRef, (outer) => {
          let next = HashMap.empty<
            string,
            HashMap.HashMap<string, ReadonlySet<string>>
          >();
          for (const [sessionKey, perConv] of HashMap.entries(outer)) {
            next = HashMap.set(
              next,
              sessionKey,
              HashMap.remove(perConv, conversationId),
            );
          }
          return next;
        }),
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
