import { MoltZapWsClient } from "@moltzap/client";
import type {
  WsClientLogger,
  MoltZapWsClientOptions,
  NotificationSubscription,
} from "@moltzap/client";
import {
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/protocol";
import type {
  AnyNotificationDefinition,
  AppManifest,
  DecodedNotification,
  Part,
  ResultOf,
  Static,
  Message,
  AppSession,
  MessageReceivedNotification,
  AppSessionReadyNotification,
  AppSessionClosedNotification,
  AppParticipantAdmittedNotification,
  AppParticipantRejectedNotification,
  BeforeDispatchContext,
  BeforeMessageDeliveryContext,
  OnSessionActiveContext,
  OnJoinContext,
  OnCloseContext,
  DispatchAdmissionResult,
  HookResult,
  AnyAppCallbackRpcDefinition,
} from "@moltzap/protocol";
import type { ServerRpcHandler } from "@moltzap/client";
import { Cause, Effect, Exit, Fiber } from "effect";
import { AppSessionHandle } from "./session.js";
import { HeartbeatManager } from "./heartbeat.js";
import {
  AppHandlerError,
  AttachAlreadyAttachedError,
  AttachConversationNotFoundError,
  type AttachError,
  AttachFailedError,
  AttachNotAuthorizedError,
  AttachSessionNotFoundError,
  AuthError,
  ConversationKeyError,
  DuplicateHookHandlerError,
  type AppError,
  InvalidConfigError,
  ManifestRegistrationError,
  SessionError,
  SessionClosedError,
  SendError,
  UserHandlerError,
} from "./errors.js";

import {
  AppsAttachConversation,
  AppsCloseSession,
  AppsCreate,
  AppsGetSession,
  ErrorCodes,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  AppSessionReadyNotificationDefinition,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnJoin,
  AppsOnSessionActive,
  AppsRegister,
  agentId,
  bindNotificationHandler,
  conversationId as toConversationId,
  defineEffectNotificationHandlers,
  defineNotificationGroup,
  isDecodedNotificationInGroup,
  messageId as toMessageId,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  SystemPing,
} from "@moltzap/protocol";

const appSdkNotificationDefinitions = [
  AppSessionReadyNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  MessageReceivedNotificationDefinition,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
] as const;

const appSdkNotificationGroup = defineNotificationGroup(
  "appSdk",
  appSdkNotificationDefinitions,
);

type MessageHandler = (message: Message) => void | Promise<void>;
type SessionReadyHandler = (session: AppSessionHandle) => void | Promise<void>;
export interface MoltZapAppOptions {
  serverUrl: string;
  agentKey: string;
  /** Minimal mode: just provide appId, defaults for everything else */
  appId?: string;
  /** Advanced mode: full manifest */
  manifest?: AppManifest;
  logger?: WsClientLogger;
  /** Application-level heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Agents to invite when start() is called */
  invitedAgentIds?: string[];
}

export type StartError = AuthError | ManifestRegistrationError | SessionError;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const NO_BACKGROUND_FIBERS = 0;

const errorCause = (cause: unknown): { readonly cause?: Error } =>
  cause instanceof Error ? { cause } : {};

/**
 * MoltZapApp — main class for building MoltZap apps.
 *
 * Primary API returns Effect. For async/await consumers, each fallible
 * method has an `*Async` sibling that runs the Effect via `Effect.runPromise`.
 */
export class MoltZapApp {
  /** Escape hatch: raw WebSocket client for advanced use */
  readonly client: MoltZapWsClient;

  private readonly manifest: AppManifest;
  private readonly heartbeat: HeartbeatManager;
  private readonly heartbeatIntervalMs: number;
  private readonly invitedAgentIds: string[];
  private readonly logger: WsClientLogger;

  private sessions = new Map<string, AppSessionHandle>();
  /** Reverse map: conversationId -> conversation key */
  private reverseConvMap = new Map<string, string>();
  /** Sessions for which sessionReady handlers have fired (dedup across start() + notification) */
  private firedSessionReady = new Set<string>();

  private sessionReadyHandlers: SessionReadyHandler[] = [];
  private messageHandlers = new Map<string, MessageHandler>();
  private participantAdmittedHandlers: ((
    notification: AppParticipantAdmittedNotification,
  ) => void)[] = [];
  private participantRejectedHandlers: ((
    notification: AppParticipantRejectedNotification,
  ) => void)[] = [];
  private errorHandler: ((error: AppError) => void) | null = null;

  /** Forked handler/recovery fibers; interrupted on stop(). */
  private backgroundFibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>();
  /** Session IDs currently being recovered after reconnect; prevents duplicate recovery fibers on flapping networks. */
  private recoveringSessions = new Set<string>();

  private started = false;
  /** Handle from the `{}` notification subscription registered in `start()`. Stored so
   *  `stop()` can unsubscribe cleanly, and `start()` can unsubscribe before
   *  rethrowing if a later step fails (preventing subscription leaks on retry). */
  private activeSubscription: NotificationSubscription | null = null;
  private readonly notificationHandlers = this.createNotificationHandlers();

  constructor(options: MoltZapAppOptions) {
    if (!options.appId && !options.manifest) {
      throw new InvalidConfigError({
        message: "Either appId or manifest must be provided",
      });
    }

    this.manifest = options.manifest ?? {
      appId: options.appId!,
      name: options.appId!,
      conversations: [
        { key: "default", name: options.appId!, participantFilter: "all" },
      ],
    };

    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.invitedAgentIds = options.invitedAgentIds ?? [];
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.heartbeat = new HeartbeatManager();

    const wsOptions: MoltZapWsClientOptions = {
      serverUrl: options.serverUrl,
      agentKey: options.agentKey,
      onDisconnect: (close) => {
        // Spec #222 OQ-6: arg required. `handleDisconnect` doesn't read
        // close metadata today; signature kept explicit so a future
        // disconnect-handler chain can plumb code/reason through.
        void close;
        this.handleDisconnect();
      },
      onReconnect: () => this.handleReconnect(),
      logger: this.logger,
    };

    this.client = new MoltZapWsClient(wsOptions);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): Effect.Effect<AppSessionHandle, StartError> {
    return Effect.gen(this, function* () {
      // Spec #222 OQ-4 deletion: per-notification `onNotification` callback is gone.
      // Replacement: register a `{}` filter subscription before
      // `connect()` so every inbound notification still reaches `handleNotification`.
      const sub = yield* this.client
        .subscribe({}, (notification) =>
          Effect.sync(() => this.handleNotification(notification)),
        )
        .pipe(
          Effect.mapError(
            (err) =>
              new AuthError({
                message: "Failed to register notification subscription",
                ...errorCause(err),
              }),
          ),
        );

      // Track the handle so stop() can unsubscribe, and so tapError below
      // can clean up if a later step fails (preventing subscription leaks).
      this.activeSubscription = sub;

      yield* this.client.connect().pipe(
        Effect.mapError(
          (err) =>
            new AuthError({
              message: "Failed to connect and authenticate",
              ...errorCause(err),
            }),
        ),
      );

      yield* this.client
        .sendRpc(AppsRegister, { manifest: this.manifest })
        .pipe(
          Effect.mapError(
            (err) =>
              new ManifestRegistrationError({
                message: `Failed to register manifest for "${this.manifest.appId}"`,
                ...errorCause(err),
              }),
          ),
        );

      const sessionResult = (yield* this.client
        .sendRpc(AppsCreate, {
          appId: this.manifest.appId,
          invitedAgentIds: this.invitedAgentIds.map(agentId),
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new SessionError({
                message: "Failed to create app session",
                ...errorCause(err),
              }),
          ),
        )) as { session: AppSession };

      const handle = new AppSessionHandle(sessionResult.session);
      this.sessions.set(handle.id, handle);
      this.buildReverseConvMap(handle);

      this.heartbeat.start(
        () => this.sendPing(),
        this.heartbeatIntervalMs,
        (err) => {
          this.logger.warn("Heartbeat ping failed:", err.message);
          this.trackFork(this.client.disconnect());
        },
      );

      this.started = true;

      if (handle.isActive) {
        this.fireSessionReady(handle);
      }

      return handle;
    }).pipe(
      // If any step after subscribe() fails, clean up the subscription so
      // a retry does not accumulate orphaned subscriptions.
      Effect.tapError(() => {
        const sub = this.activeSubscription;
        if (sub !== null) {
          this.activeSubscription = null;
          return sub.unsubscribe;
        }
        return Effect.void;
      }),
    );
  }

  stop(): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      this.heartbeat.destroy();

      const pending = [...this.backgroundFibers];
      this.backgroundFibers.clear();
      this.recoveringSessions.clear();
      if (pending.length > NO_BACKGROUND_FIBERS) {
        yield* Fiber.interruptAll(pending);
      }

      for (const session of this.sessions.values()) {
        if (session.isActive) {
          yield* this.client
            .sendRpc(AppsCloseSession, { sessionId: session.id })
            .pipe(Effect.ignore);
        }
      }

      this.sessions.clear();
      this.reverseConvMap.clear();
      this.firedSessionReady.clear();

      if (this.activeSubscription !== null) {
        yield* this.activeSubscription.unsubscribe;
        this.activeSubscription = null;
      }

      yield* this.client.close();
      this.started = false;
    });
  }

  /**
   * Fork a background Effect and track the fiber so stop() can interrupt it.
   * Used for user-handler dispatch, skill-challenge attestation, and post-reconnect
   * session recovery, all of which must not outlive the app.
   */
  private trackFork<E>(effect: Effect.Effect<void, E>): void {
    const fibers = this.backgroundFibers;
    const fiber = Effect.runFork(effect) as Fiber.RuntimeFiber<
      unknown,
      unknown
    >;
    fibers.add(fiber);
    fiber.addObserver(() => {
      fibers.delete(fiber);
    });
  }

  // ── Session management ─────────────────────────────────────────────

  createSession(
    invitedAgentIds?: string[],
  ): Effect.Effect<AppSessionHandle, SessionError> {
    return Effect.gen(this, function* () {
      const result = (yield* this.client
        .sendRpc(AppsCreate, {
          appId: this.manifest.appId,
          invitedAgentIds: (invitedAgentIds ?? []).map(agentId),
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new SessionError({
                message: "Failed to create app session",
                ...errorCause(err),
              }),
          ),
        )) as { session: AppSession };

      const handle = new AppSessionHandle(result.session);
      this.sessions.set(handle.id, handle);
      this.buildReverseConvMap(handle);
      return handle;
    });
  }

  getSession(sessionId: string): AppSessionHandle | undefined {
    return this.sessions.get(sessionId);
  }

  get activeSessions(): AppSessionHandle[] {
    return [...this.sessions.values()].filter((s) => s.isActive);
  }

  // ── Notification registration ──────────────────────────────────────

  onSessionReady(
    handler: (session: AppSessionHandle) => void | Promise<void>,
  ): void {
    this.sessionReadyHandlers.push(handler);
  }

  onMessage(conversationKey: string, handler: MessageHandler): void {
    this.messageHandlers.set(conversationKey, handler);
  }

  onParticipantAdmitted(
    handler: (notification: AppParticipantAdmittedNotification) => void,
  ): void {
    this.participantAdmittedHandlers.push(handler);
  }

  onParticipantRejected(
    handler: (notification: AppParticipantRejectedNotification) => void,
  ): void {
    this.participantRejectedHandlers.push(handler);
  }

  onError(handler: (error: AppError) => void): void {
    this.errorHandler = handler;
  }

  // ── Admission + lifecycle handler surface (Phase 1.4 / B.5) ─────────────
  //
  // Each `onX(handler)` registers against the corresponding app-callback
  // RPC verb (`apps/onBeforeDispatch`, `apps/onBeforeMessageDelivery`,
  // `apps/onSessionActive`, `apps/onJoin`, `apps/onClose`). The underlying
  // `client.handleServerRpc` decodes inbound frames against the protocol
  // schemas and writes the encoded reply back; the wrapper functions below
  // shape the user handler's `Effect<Verdict, never>` into the SDK's
  // fail-closed contract:
  //
  //   - onBeforeDispatch         handler defect → `{decision: "deny", reason: "app_handler_error"}`
  //   - onBeforeMessageDelivery  handler defect → `{block: true,  reason: "app_handler_error"}`
  //   - on_session_active / on_join / on_close   handler defect → void; logged
  //
  // Duplicate registration on the same hook surfaces synchronously as
  // `AppError("DUPLICATE_HOOK_HANDLER")`.

  /**
   * Register a `before_dispatch` admission handler. AppHost calls this
   * before delivering an outbound message to a recipient; the handler
   * returns a `DispatchAdmissionResult` (grant / deny / hold).
   *
   * The user Effect is invoked once per inbound RPC, the verdict is wrapped
   * into the protocol's `{ admission }` envelope, and any defect synthesizes
   * a fail-closed `deny`. Calling twice throws `AppError("DUPLICATE_HOOK_HANDLER")`.
   */
  onBeforeDispatch(
    handler: (
      ctx: BeforeDispatchContext,
    ) => Effect.Effect<DispatchAdmissionResult, never>,
  ): void {
    this.registerAdmissionHandler(
      AppsOnBeforeDispatch,
      handler,
      (decision) => ({ admission: decision }),
      () => ({ admission: { decision: "deny", reason: "app_handler_error" } }),
    );
  }

  /**
   * Register a `before_message_delivery` admission handler. Returning
   * `{ block: false }` allows; `{ block: true, reason }` drops; supplying
   * `patch.parts` mutates the recipient view; `feedback` emits an
   * observability hook.
   *
   * Handler defects synthesize fail-closed `{ block: true,
   * reason: "app_handler_error" }`. Calling twice throws
   * `AppError("DUPLICATE_HOOK_HANDLER")`.
   */
  onBeforeMessageDelivery(
    handler: (
      ctx: BeforeMessageDeliveryContext,
    ) => Effect.Effect<HookResult, never>,
  ): void {
    this.registerAdmissionHandler(
      AppsOnBeforeMessageDelivery,
      handler,
      (verdict) => verdict,
      () => ({ block: true, reason: "app_handler_error" }),
    );
  }

  /**
   * Register an awaitable `on_session_active` lifecycle handler. AppHost
   * gates `app/sessionReady` delivery on the handler completing (preserves
   * `31-on-session-active.integration.test.ts:200-230` ordering).
   *
   * Handler defects log + reply void; the lifecycle hook never blocks the
   * session.
   */
  onSessionActive(
    handler: (ctx: OnSessionActiveContext) => Effect.Effect<void, never>,
  ): void {
    this.registerLifecycleHandler(AppsOnSessionActive, handler);
  }

  /** Register an awaitable `on_join` lifecycle handler. */
  onJoin(handler: (ctx: OnJoinContext) => Effect.Effect<void, never>): void {
    this.registerLifecycleHandler(AppsOnJoin, handler);
  }

  /** Register an awaitable `on_close` lifecycle handler. */
  onClose(handler: (ctx: OnCloseContext) => Effect.Effect<void, never>): void {
    this.registerLifecycleHandler(AppsOnClose, handler);
  }

  /**
   * Attach an existing conversation to a session for membership / role-DM
   * purposes. Wraps the client-originated RPC `apps/attachConversation`.
   *
   * Errors map server response codes to `AttachError`:
   *   - `SessionNotFound`, `ConversationNotFound`, `NotAuthorized` → typed
   *   - any other RPC failure (timeout, transport) → `AttachFailed`
   */
  attachConversation(
    sessionId: string,
    conversationId: string,
  ): Effect.Effect<void, AttachError> {
    return this.client
      .sendRpc(AppsAttachConversation, {
        sessionId,
        conversationId: toConversationId(conversationId),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((err) => mapAttachError(err)),
      );
  }

  /**
   * Wire a user-supplied admission handler against the SDK's WS client.
   *
   * `wrapVerdict` adapts the user verdict to the on-the-wire result shape
   * (e.g. `{ admission }` for `before_dispatch`); `failClosedVerdict` is
   * the wire-shape verdict synthesized when the user handler defects.
   *
   * `Effect.runSyncExit` is safe here: `handleServerRpc` mutates a `Ref`
   * synchronously and only fails with `DuplicateServerRpcHandlerError`.
   */
  private registerAdmissionHandler<
    D extends AnyAppCallbackRpcDefinition,
    Verdict,
  >(
    definition: D,
    handler: (ctx: Static<D["paramsSchema"]>) => Effect.Effect<Verdict, never>,
    wrapVerdict: (verdict: Verdict) => ResultOf<D>,
    failClosedVerdict: () => ResultOf<D>,
  ): void {
    const method = definition.name;
    const wrapped: ServerRpcHandler<D> = (
      params,
    ): Effect.Effect<ResultOf<D>, RpcServerError> =>
      Effect.gen(this, function* () {
        const verdictExit = yield* Effect.exit(handler(params));
        if (Exit.isSuccess(verdictExit)) {
          return wrapVerdict(verdictExit.value);
        }
        // Fail-closed: log the underlying cause, synthesize the fail-closed
        // verdict. Cause covers both typed failures (which are `never`-typed
        // here so should not occur) and defects from `Effect.gen` throws.
        const wrappedErr = new AppHandlerError({
          method,
          message: "handler failed; synthesizing fail-closed verdict",
          cause: causeToError(verdictExit.cause),
        });
        this.emitError(wrappedErr);
        return failClosedVerdict();
      });

    this.installServerRpc(definition, wrapped);
  }

  private registerLifecycleHandler<D extends AnyAppCallbackRpcDefinition>(
    definition: D,
    handler: (ctx: Static<D["paramsSchema"]>) => Effect.Effect<void, never>,
  ): void {
    const method = definition.name;
    const wrapped: ServerRpcHandler<D> = (
      params,
    ): Effect.Effect<ResultOf<D>, RpcServerError> =>
      Effect.gen(this, function* () {
        const exit = yield* Effect.exit(handler(params));
        if (Exit.isFailure(exit)) {
          // Lifecycle hooks are awaitable-void: log and reply void so the
          // server-side AppHost stops waiting. Never blocks session lifecycle.
          this.emitError(
            new AppHandlerError({
              method,
              message: "lifecycle handler failed; replying void",
              cause: causeToError(exit.cause),
            }),
          );
        }
        const result: unknown = {};
        if (isRpcResult(definition, result)) {
          return result;
        }
        return yield* Effect.fail(
          new RpcServerError({
            code: ErrorCodes.InternalError,
            message: `Invalid lifecycle result for ${method}`,
          }),
        );
      });

    this.installServerRpc(definition, wrapped);
  }

  private installServerRpc<D extends AnyAppCallbackRpcDefinition>(
    definition: D,
    wrapped: ServerRpcHandler<D>,
  ): void {
    const method = definition.name;
    const exit = Effect.runSyncExit(
      this.client.handleServerRpc(definition, wrapped),
    );
    if (Exit.isFailure(exit)) {
      // Only failure mode is `DuplicateServerRpcHandlerError`; surface as
      // sync throw per architect plan §3.5 ("Multiple registrations for the
      // same hook throw at registration time").
      throw new DuplicateHookHandlerError({
        method,
        message: `Handler already registered for ${method}`,
        cause: causeToError(exit.cause),
      });
    }
  }

  // ── Messaging ──────────────────────────────────────────────────────

  /** Send a message to a conversation by key (resolved via session conversation map) */
  send(
    conversationKey: string,
    parts: Part[],
  ): Effect.Effect<void, SendError | ConversationKeyError> {
    return Effect.gen(this, function* () {
      const conversationId =
        yield* this.resolveConversationKey(conversationKey);
      yield* this.sendTo(conversationId, parts);
    });
  }

  /** Send a message to a conversation by raw conversation ID */
  sendTo(
    conversationId: string,
    parts: Part[],
  ): Effect.Effect<void, SendError> {
    return this.client
      .sendRpc(MessagesSend, {
        conversationId: toConversationId(conversationId),
        parts,
      })
      .pipe(
        Effect.mapError(
          (err) =>
            new SendError({
              message: `Failed to send message to conversation ${conversationId}`,
              ...errorCause(err),
            }),
        ),
        Effect.asVoid,
      );
  }

  /**
   * Reply to a specific message. The server resolves the target
   * conversation from `replyToId`.
   */
  reply(messageId: string, parts: Part[]): Effect.Effect<void, SendError> {
    return this.client
      .sendRpc(MessagesSend, { replyToId: toMessageId(messageId), parts })
      .pipe(
        Effect.mapError(
          (err) =>
            new SendError({
              message: `Failed to reply to message ${messageId}`,
              ...errorCause(err),
            }),
        ),
        Effect.asVoid,
      );
  }

  // ── Promise bridges for async/await consumers ──────────────────────
  // These thin `*Async` wrappers exist so downstream apps that are not
  // built on Effect can still use the SDK with plain async/await.
  // The primary API is the Effect-returning sibling on each method.

  startAsync() {
    return Effect.runPromise(this.start());
  }

  stopAsync() {
    return Effect.runPromise(this.stop());
  }

  createSessionAsync(invitedAgentIds?: string[]) {
    return Effect.runPromise(this.createSession(invitedAgentIds));
  }

  sendAsync(conversationKey: string, parts: Part[]) {
    return Effect.runPromise(this.send(conversationKey, parts));
  }

  sendToAsync(conversationId: string, parts: Part[]) {
    return Effect.runPromise(this.sendTo(conversationId, parts));
  }

  replyAsync(messageId: string, parts: Part[]) {
    return Effect.runPromise(this.reply(messageId, parts));
  }

  // ── Internal ───────────────────────────────────────────────────────

  private resolveConversationKey(
    key: string,
  ): Effect.Effect<string, ConversationKeyError> {
    for (const session of this.sessions.values()) {
      const id = session.conversations[key];
      if (id) return Effect.succeed(id);
    }
    return Effect.fail(
      new ConversationKeyError({
        key,
        message: `Unknown conversation key: "${key}"`,
      }),
    );
  }

  private buildReverseConvMap(session: AppSessionHandle): void {
    for (const [key, convId] of Object.entries(session.conversations)) {
      this.reverseConvMap.set(convId, key);
    }
  }

  private handleNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    if (!isDecodedNotificationInGroup(appSdkNotificationGroup, notification)) {
      return;
    }
    Effect.runSync(this.notificationHandlers.dispatch(notification));
  }

  private createNotificationHandlers() {
    return defineEffectNotificationHandlers(appSdkNotificationGroup, [
      bindNotificationHandler(AppSessionReadyNotificationDefinition, (params) =>
        Effect.sync(() => this.handleSessionReady(params)),
      ),
      bindNotificationHandler(
        AppSessionClosedNotificationDefinition,
        (params) => Effect.sync(() => this.handleSessionClosed(params)),
      ),
      bindNotificationHandler(MessageReceivedNotificationDefinition, (params) =>
        Effect.sync(() => this.handleMessage(params)),
      ),
      bindNotificationHandler(
        AppParticipantAdmittedNotificationDefinition,
        (params) => Effect.sync(() => this.handleParticipantAdmitted(params)),
      ),
      bindNotificationHandler(
        AppParticipantRejectedNotificationDefinition,
        (params) => Effect.sync(() => this.handleParticipantRejected(params)),
      ),
    ]);
  }

  private handleSessionReady(data: AppSessionReadyNotification): void {
    let handle = this.sessions.get(data.sessionId);
    if (handle) {
      handle = new AppSessionHandle({
        id: data.sessionId,
        appId: handle.appId,
        status: "active",
        conversations: data.conversations,
      });
      this.sessions.set(data.sessionId, handle);
      this.buildReverseConvMap(handle);
    }

    if (handle) {
      this.fireSessionReady(handle);
    }
  }

  private handleSessionClosed(data: AppSessionClosedNotification): void {
    const handle = this.sessions.get(data.sessionId);
    if (handle) {
      for (const convId of Object.values(handle.conversations)) {
        this.reverseConvMap.delete(convId);
      }
      this.sessions.delete(data.sessionId);
      this.firedSessionReady.delete(data.sessionId);
      this.emitError(
        new SessionClosedError({
          message: `Session ${data.sessionId} was closed`,
        }),
      );
    }
  }

  private handleMessage(data: MessageReceivedNotification): void {
    const message = data.message as Message;
    const key = this.reverseConvMap.get(message.conversationId);

    if (key && this.messageHandlers.has(key)) {
      const handler = this.messageHandlers.get(key)!;
      this.trackFork(
        this.runUserHandler(() => handler(message), {
          message: `Message handler for "${key}" threw`,
        }),
      );
    }

    if (this.messageHandlers.has("*")) {
      const handler = this.messageHandlers.get("*")!;
      this.trackFork(
        this.runUserHandler(() => handler(message), {
          message: "Catch-all message handler threw",
        }),
      );
    }
  }

  /**
   * Invoke a user-supplied handler that may return `void | Promise<void>`,
   * catching both synchronous throws and Promise rejections. Failures emit
   * via `onError` with the provided context.
   */
  private runUserHandler(
    invoke: () => void | Promise<void>,
    ctx: { message: string },
  ): Effect.Effect<void, never> {
    return Effect.try({
      try: invoke,
      catch: (e): Error => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(
      Effect.flatMap((result) =>
        result instanceof Promise
          ? Effect.tryPromise({
              try: () => result,
              catch: (e): Error =>
                e instanceof Error ? e : new Error(String(e)),
            })
          : Effect.void,
      ),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          this.emitError(
            new UserHandlerError({ message: ctx.message, cause: err }),
          );
        }),
      ),
    );
  }

  private handleParticipantAdmitted(
    data: AppParticipantAdmittedNotification,
  ): void {
    for (const handler of this.participantAdmittedHandlers) {
      handler(data);
    }
  }

  private handleParticipantRejected(
    data: AppParticipantRejectedNotification,
  ): void {
    for (const handler of this.participantRejectedHandlers) {
      handler(data);
    }
  }

  private fireSessionReady(handle: AppSessionHandle): void {
    // Dedup: session can become active via both the apps/create result and
    // a subsequent app/sessionReady notification — handlers must only fire once.
    if (this.firedSessionReady.has(handle.id)) return;
    this.firedSessionReady.add(handle.id);

    for (const handler of this.sessionReadyHandlers) {
      this.trackFork(
        this.runUserHandler(() => handler(handle), {
          message: "Session ready handler threw",
        }),
      );
    }
  }

  private handleDisconnect(): void {
    this.heartbeat.stop();
    this.logger.warn("Disconnected from server");
  }

  private handleReconnect(): void {
    this.logger.info("Reconnected to server");

    for (const session of this.sessions.values()) {
      if (this.recoveringSessions.has(session.id)) continue;
      this.recoveringSessions.add(session.id);
      this.trackFork(this.recoverSessionOnReconnect(session));
    }

    this.heartbeat.start(
      () => this.sendPing(),
      this.heartbeatIntervalMs,
      (err) => {
        this.logger.warn("Heartbeat ping failed:", err.message);
        this.trackFork(this.client.disconnect());
      },
    );
  }

  private recoverSessionOnReconnect(
    session: AppSessionHandle,
  ): Effect.Effect<void, never> {
    return this.client.sendRpc(AppsGetSession, { sessionId: session.id }).pipe(
      Effect.flatMap((result: unknown) =>
        Effect.sync(() => {
          const { session: freshSession } = result as {
            session: AppSession;
          };
          if (
            freshSession.status === "closed" ||
            freshSession.status === "failed"
          ) {
            this.sessions.delete(session.id);
            this.firedSessionReady.delete(session.id);
            for (const convId of Object.values(session.conversations)) {
              this.reverseConvMap.delete(convId);
            }
            this.emitError(
              new SessionClosedError({
                message: `Session ${session.id} closed during disconnect`,
              }),
            );
          } else {
            const updated = new AppSessionHandle(freshSession);
            this.sessions.set(session.id, updated);
            this.buildReverseConvMap(updated);
          }
        }),
      ),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          this.emitError(
            new SessionError({
              message: `Failed to recover session ${session.id} after reconnect`,
              ...errorCause(err),
            }),
          );
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.recoveringSessions.delete(session.id);
        }),
      ),
    );
  }

  private sendPing(): Effect.Effect<void, Error> {
    return this.client.sendRpc(SystemPing, {}).pipe(
      Effect.asVoid,
      Effect.mapError(
        (e): Error => (e instanceof Error ? e : new Error(String(e))),
      ),
    );
  }

  private emitError(error: AppError): void {
    if (this.errorHandler) {
      this.errorHandler(error);
    } else {
      this.logger.error(`[${error._tag}] ${error.message}`);
    }
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────

/**
 * Coerce an Effect `Cause` into a plain `Error` for error chaining. Defects
 * carrying an `Error` are unwrapped; everything else is stringified.
 */
function causeToError(cause: Cause.Cause<unknown>): Error {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    return failure.value instanceof Error
      ? failure.value
      : new Error(String(failure.value));
  }
  const defect = Cause.dieOption(cause);
  if (defect._tag === "Some") {
    return defect.value instanceof Error
      ? defect.value
      : new Error(String(defect.value));
  }
  return new Error(Cause.pretty(cause));
}

function isRpcResult<D extends AnyAppCallbackRpcDefinition>(
  definition: D,
  value: unknown,
): value is ResultOf<D> {
  return definition.validateResult(value);
}

/**
 * Map a `client.sendRpc` failure for `apps/attachConversation` onto the
 * SDK's typed `AttachError`. RPC server errors carry the server's reason in
 * `data.code` (or `message`); transport / timeout errors collapse to
 * `AttachFailedError`.
 */
type SendRpcError = NotConnectedError | RpcTimeoutError | RpcServerError;

function mapAttachError(err: SendRpcError): AttachError {
  if (err instanceof RpcServerError) {
    return makeAttachError(extractAttachKind(err), err.message, err);
  }
  // NotConnectedError or RpcTimeoutError — both extend Error via Data.TaggedError.
  return new AttachFailedError({
    message: `attachConversation failed: ${err.message}`,
    ...errorCause(err),
  });
}

type AttachFailureKind =
  | "SessionNotFound"
  | "ConversationNotFound"
  | "NotAuthorized"
  | "AlreadyAttached"
  | "AttachFailed";

function makeAttachError(
  kind: AttachFailureKind,
  message: string,
  cause: Error,
): AttachError {
  switch (kind) {
    case "SessionNotFound":
      return new AttachSessionNotFoundError({ message, cause });
    case "ConversationNotFound":
      return new AttachConversationNotFoundError({ message, cause });
    case "NotAuthorized":
      return new AttachNotAuthorizedError({ message, cause });
    case "AlreadyAttached":
      return new AttachAlreadyAttachedError({ message, cause });
    case "AttachFailed":
      return new AttachFailedError({ message, cause });
  }
}

/**
 * Numeric JSON-RPC error code → SDK attach error tag mapping. Matches the
 * server's `ErrorCodes` table (see `packages/protocol/src/schema/errors.ts`)
 * — kept inline (no protocol import) because the SDK already pins
 * `@moltzap/protocol` for context types and re-importing the constants
 * would make the SDK fail closed if the server ever renames a code
 * without matching downstream support; an inline table is one explicit
 * boundary that stays in sync via the integration test for
 * `apps/attachConversation` happy + error paths.
 */
const NumericCodeToAttach: Record<number, AttachFailureKind> = {
  [-32021]: "SessionNotFound", // ErrorCodes.SessionNotFound
  [-32002]: "ConversationNotFound", // ErrorCodes.NotFound (used for missing convId)
  [-32001]: "NotAuthorized", // ErrorCodes.Forbidden
  [-32003]: "AlreadyAttached", // ErrorCodes.Conflict (1:1 cross-session collision)
};

function extractAttachKind(err: RpcServerError): AttachFailureKind {
  // 1. Prefer the wire-level numeric `err.code`. The real server emits
  //    JSON-RPC numeric codes from `ErrorCodes` (e.g. `SessionNotFound =
  //    -32021`), NOT the AttachError tag string. Numeric mapping is the
  //    primary contract.
  const numeric = NumericCodeToAttach[err.code];
  if (numeric !== undefined) return numeric;

  // 2. Structured `data.code` string — a secondary contract some servers
  //    use to disambiguate when one numeric code covers multiple SDK
  //    error tags. Preserved for compatibility with handler-level mocks.
  const data = err.data;
  if (data !== null && typeof data === "object" && "code" in data) {
    const c = (data as { code: unknown }).code;
    if (
      c === "SessionNotFound" ||
      c === "ConversationNotFound" ||
      c === "NotAuthorized" ||
      c === "AlreadyAttached"
    ) {
      return c;
    }
  }

  // 3. Last-ditch substring fallback for legacy text-only RPC errors.
  //    The "already attached" check mirrors the canonical server message
  //    emitted on Conflict (-32003) — see
  //    `packages/server/src/app/app-host.ts` ("Conversation X is already
  //    attached to session Y").
  if (err.message.includes("SessionNotFound")) return "SessionNotFound";
  if (err.message.includes("ConversationNotFound")) {
    return "ConversationNotFound";
  }
  if (err.message.includes("NotAuthorized")) return "NotAuthorized";
  if (err.message.includes("already attached")) return "AlreadyAttached";

  return "AttachFailed";
}
