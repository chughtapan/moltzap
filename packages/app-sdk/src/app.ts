import {
  MoltZapWsClient,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/client";
import type {
  WsClientLogger,
  MoltZapWsClientOptions,
  EventSubscription,
} from "@moltzap/client";
import type {
  AppManifest,
  EventFrame,
  Part,
  Message,
  AppSession,
  MessageReceivedEvent,
  AppSessionReadyEvent,
  AppSessionClosedEvent,
  AppSkillChallengeEvent,
  AppParticipantAdmittedEvent,
  AppParticipantRejectedEvent,
  BeforeDispatchContext,
  BeforeMessageDeliveryContext,
  OnSessionActiveContext,
  OnJoinContext,
  OnCloseContext,
  DispatchAdmissionResult,
  HookResult,
} from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import { Cause, Effect, Exit, Fiber } from "effect";
import { AppSessionHandle } from "./session.js";
import { HeartbeatManager } from "./heartbeat.js";
import {
  AppError,
  AppHandlerError,
  AttachError,
  type AttachErrorCode,
  AuthError,
  ManifestRegistrationError,
  SessionError,
  SessionClosedError,
  ConversationKeyError,
  SendError,
} from "./errors.js";

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
  /** Sessions for which sessionReady handlers have fired (dedup across start() + event) */
  private firedSessionReady = new Set<string>();

  private sessionReadyHandlers: SessionReadyHandler[] = [];
  private messageHandlers = new Map<string, MessageHandler>();
  private participantAdmittedHandlers: ((
    event: AppParticipantAdmittedEvent,
  ) => void)[] = [];
  private participantRejectedHandlers: ((
    event: AppParticipantRejectedEvent,
  ) => void)[] = [];
  private errorHandler: ((error: AppError) => void) | null = null;

  /** Forked handler/recovery fibers; interrupted on stop(). */
  private backgroundFibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>();
  /** Session IDs currently being recovered after reconnect; prevents duplicate recovery fibers on flapping networks. */
  private recoveringSessions = new Set<string>();

  private started = false;
  /** Handle from the `{}` event subscription registered in `start()`. Stored so
   *  `stop()` can unsubscribe cleanly, and `start()` can unsubscribe before
   *  rethrowing if a later step fails (preventing subscription leaks on retry). */
  private activeSubscription: EventSubscription | null = null;

  constructor(options: MoltZapAppOptions) {
    if (!options.appId && !options.manifest) {
      throw new AppError(
        "INVALID_CONFIG",
        "Either appId or manifest must be provided",
      );
    }

    this.manifest = options.manifest ?? {
      appId: options.appId!,
      name: options.appId!,
      permissions: { required: [], optional: [] },
      conversations: [
        { key: "default", name: options.appId!, participantFilter: "all" },
      ],
    };

    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
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
      // Spec #222 OQ-6: arg required. `handleDisconnect` doesn't read
      // close metadata today; signature kept explicit so a future
      // disconnect-handler chain can plumb code/reason through.
      onDisconnect: (_close) => this.handleDisconnect(),
      onReconnect: () => this.handleReconnect(),
      logger: this.logger,
    };

    this.client = new MoltZapWsClient(wsOptions);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): Effect.Effect<AppSessionHandle, StartError> {
    return Effect.gen(this, function* () {
      // Spec #222 OQ-4 deletion: per-event `onEvent` callback is gone.
      // Replacement: register a `{}` filter subscription before
      // `connect()` so every inbound event still reaches `handleEvent`.
      const sub = yield* this.client
        .subscribe({}, (event) => Effect.sync(() => this.handleEvent(event)))
        .pipe(
          Effect.mapError(
            (err) =>
              new AuthError(
                "Failed to register event subscription",
                err instanceof Error ? err : undefined,
              ),
          ),
        );

      // Track the handle so stop() can unsubscribe, and so tapError below
      // can clean up if a later step fails (preventing subscription leaks).
      this.activeSubscription = sub;

      yield* this.client
        .connect()
        .pipe(
          Effect.mapError(
            (err) =>
              new AuthError(
                "Failed to connect and authenticate",
                err instanceof Error ? err : undefined,
              ),
          ),
        );

      yield* this.client
        .sendRpc("apps/register", { manifest: this.manifest })
        .pipe(
          Effect.mapError(
            (err) =>
              new ManifestRegistrationError(
                `Failed to register manifest for "${this.manifest.appId}"`,
                err instanceof Error ? err : undefined,
              ),
          ),
        );

      const sessionResult = (yield* this.client
        .sendRpc("apps/create", {
          appId: this.manifest.appId,
          invitedAgentIds: this.invitedAgentIds,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new SessionError(
                "Failed to create app session",
                err instanceof Error ? err : undefined,
              ),
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
      if (pending.length > 0) {
        yield* Fiber.interruptAll(pending);
      }

      for (const session of this.sessions.values()) {
        if (session.isActive) {
          yield* this.client
            .sendRpc("apps/closeSession", { sessionId: session.id })
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
        .sendRpc("apps/create", {
          appId: this.manifest.appId,
          invitedAgentIds: invitedAgentIds ?? [],
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new SessionError(
                "Failed to create app session",
                err instanceof Error ? err : undefined,
              ),
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

  // ── Event registration ─────────────────────────────────────────────

  onSessionReady(
    handler: (session: AppSessionHandle) => void | Promise<void>,
  ): void {
    this.sessionReadyHandlers.push(handler);
  }

  onMessage(conversationKey: string, handler: MessageHandler): void {
    this.messageHandlers.set(conversationKey, handler);
  }

  onParticipantAdmitted(
    handler: (event: AppParticipantAdmittedEvent) => void,
  ): void {
    this.participantAdmittedHandlers.push(handler);
  }

  onParticipantRejected(
    handler: (event: AppParticipantRejectedEvent) => void,
  ): void {
    this.participantRejectedHandlers.push(handler);
  }

  onError(handler: (error: AppError) => void): void {
    this.errorHandler = handler;
  }

  // ── Admission + lifecycle handler surface (Phase 1.4 / B.5) ─────────────
  //
  // Each `onX(handler)` registers against the corresponding s2c admission
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
    this.registerAdmissionHandler<
      BeforeDispatchContext,
      DispatchAdmissionResult
    >(
      "apps/onBeforeDispatch",
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
    this.registerAdmissionHandler<BeforeMessageDeliveryContext, HookResult>(
      "apps/onBeforeMessageDelivery",
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
    this.registerLifecycleHandler<OnSessionActiveContext>(
      "apps/onSessionActive",
      handler,
    );
  }

  /** Register an awaitable `on_join` lifecycle handler. */
  onJoin(handler: (ctx: OnJoinContext) => Effect.Effect<void, never>): void {
    this.registerLifecycleHandler<OnJoinContext>("apps/onJoin", handler);
  }

  /** Register an awaitable `on_close` lifecycle handler. */
  onClose(handler: (ctx: OnCloseContext) => Effect.Effect<void, never>): void {
    this.registerLifecycleHandler<OnCloseContext>("apps/onClose", handler);
  }

  /**
   * Attach an existing conversation to a session for membership / role-DM
   * purposes. Wraps the c2s RPC `apps/attachConversation`.
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
      .sendRpc("apps/attachConversation", { sessionId, conversationId })
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
  private registerAdmissionHandler<Ctx, Verdict>(
    method: string,
    handler: (ctx: Ctx) => Effect.Effect<Verdict, never>,
    wrapVerdict: (verdict: Verdict) => unknown,
    failClosedVerdict: () => unknown,
  ): void {
    const wrapped = (params: unknown): Effect.Effect<unknown, RpcServerError> =>
      Effect.gen(this, function* () {
        const ctx = params as Ctx;
        const verdictExit = yield* Effect.exit(handler(ctx));
        if (Exit.isSuccess(verdictExit)) {
          return wrapVerdict(verdictExit.value);
        }
        // Fail-closed: log the underlying cause, synthesize the fail-closed
        // verdict. Cause covers both typed failures (which are `never`-typed
        // here so should not occur) and defects from `Effect.gen` throws.
        const wrappedErr = new AppHandlerError(
          method,
          "handler failed; synthesizing fail-closed verdict",
          causeToError(verdictExit.cause),
        );
        this.emitError(wrappedErr);
        return failClosedVerdict();
      });

    this.installServerRpc(method, wrapped);
  }

  private registerLifecycleHandler<Ctx>(
    method: string,
    handler: (ctx: Ctx) => Effect.Effect<void, never>,
  ): void {
    const wrapped = (params: unknown): Effect.Effect<unknown, RpcServerError> =>
      Effect.gen(this, function* () {
        const ctx = params as Ctx;
        const exit = yield* Effect.exit(handler(ctx));
        if (Exit.isFailure(exit)) {
          // Lifecycle hooks are awaitable-void: log and reply void so the
          // server-side AppHost stops waiting. Never blocks session lifecycle.
          this.emitError(
            new AppHandlerError(
              method,
              "lifecycle handler failed; replying void",
              causeToError(exit.cause),
            ),
          );
        }
        return {};
      });

    this.installServerRpc(method, wrapped);
  }

  private installServerRpc(
    method: string,
    wrapped: (params: unknown) => Effect.Effect<unknown, RpcServerError>,
  ): void {
    const exit = Effect.runSyncExit(
      this.client.handleServerRpc(method, wrapped),
    );
    if (Exit.isFailure(exit)) {
      // Only failure mode is `DuplicateServerRpcHandlerError`; surface as
      // sync throw per architect plan §3.5 ("Multiple registrations for the
      // same hook throw at registration time").
      throw new AppError(
        "DUPLICATE_HOOK_HANDLER",
        `Handler already registered for ${method}`,
        causeToError(exit.cause),
      );
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
    return this.client.sendRpc("messages/send", { conversationId, parts }).pipe(
      Effect.mapError(
        (err) =>
          new SendError(
            `Failed to send message to conversation ${conversationId}`,
            err instanceof Error ? err : undefined,
          ),
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
      .sendRpc("messages/send", { replyToId: messageId, parts })
      .pipe(
        Effect.mapError(
          (err) =>
            new SendError(
              `Failed to reply to message ${messageId}`,
              err instanceof Error ? err : undefined,
            ),
        ),
        Effect.asVoid,
      );
  }

  // ── Promise bridges for async/await consumers ──────────────────────
  // These thin `*Async` wrappers exist so downstream apps that are not
  // built on Effect can still use the SDK with plain async/await.
  // The primary API is the Effect-returning sibling on each method.

  // #ignore-sloppy-code-next-line[promise-type]: Promise bridge for async/await consumers
  startAsync(): Promise<AppSessionHandle> {
    return Effect.runPromise(this.start());
  }

  // #ignore-sloppy-code-next-line[promise-type]: Promise bridge for async/await consumers
  stopAsync(): Promise<void> {
    return Effect.runPromise(this.stop());
  }

  // #ignore-sloppy-code-next-line[promise-type]: Promise bridge for async/await consumers
  createSessionAsync(invitedAgentIds?: string[]): Promise<AppSessionHandle> {
    return Effect.runPromise(this.createSession(invitedAgentIds));
  }

  // #ignore-sloppy-code-next-line[promise-type]: Promise bridge for async/await consumers
  sendAsync(conversationKey: string, parts: Part[]): Promise<void> {
    return Effect.runPromise(this.send(conversationKey, parts));
  }

  // #ignore-sloppy-code-next-line[promise-type]: Promise bridge for async/await consumers
  sendToAsync(conversationId: string, parts: Part[]): Promise<void> {
    return Effect.runPromise(this.sendTo(conversationId, parts));
  }

  // #ignore-sloppy-code-next-line[promise-type]: Promise bridge for async/await consumers
  replyAsync(messageId: string, parts: Part[]): Promise<void> {
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
    return Effect.fail(new ConversationKeyError(key));
  }

  private buildReverseConvMap(session: AppSessionHandle): void {
    for (const [key, convId] of Object.entries(session.conversations)) {
      this.reverseConvMap.set(convId, key);
    }
  }

  private handleEvent(event: EventFrame): void {
    if (event.data === undefined) return;

    // The server validates event.data against each event's schema before
    // emitting; ws-client also validates the EventFrame envelope. Each case
    // casts data to the typed Static<> payload for that specific event.
    switch (event.event) {
      case EventNames.AppSessionReady:
        this.handleSessionReady(event.data as AppSessionReadyEvent);
        break;
      case EventNames.AppSessionClosed:
        this.handleSessionClosed(event.data as AppSessionClosedEvent);
        break;
      case EventNames.AppSkillChallenge:
        this.handleSkillChallenge(event.data as AppSkillChallengeEvent);
        break;
      case EventNames.MessageReceived:
        this.handleMessage(event.data as MessageReceivedEvent);
        break;
      case EventNames.AppParticipantAdmitted:
        this.handleParticipantAdmitted(
          event.data as AppParticipantAdmittedEvent,
        );
        break;
      case EventNames.AppParticipantRejected:
        this.handleParticipantRejected(
          event.data as AppParticipantRejectedEvent,
        );
        break;
    }
  }

  private handleSessionReady(data: AppSessionReadyEvent): void {
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

  private handleSessionClosed(data: AppSessionClosedEvent): void {
    const handle = this.sessions.get(data.sessionId);
    if (handle) {
      for (const convId of Object.values(handle.conversations)) {
        this.reverseConvMap.delete(convId);
      }
      this.sessions.delete(data.sessionId);
      this.firedSessionReady.delete(data.sessionId);
      this.emitError(
        new SessionClosedError(`Session ${data.sessionId} was closed`),
      );
    }
  }

  private handleSkillChallenge(data: AppSkillChallengeEvent): void {
    const skillUrl = this.manifest.skillUrl;

    if (skillUrl) {
      this.trackFork(
        this.client
          .sendRpc("apps/attestSkill", {
            challengeId: data.challengeId,
            skillUrl,
            version: this.manifest.skillMinVersion ?? "0.0.0",
          })
          .pipe(
            Effect.asVoid,
            Effect.catchAll((err) =>
              Effect.sync(() => {
                this.emitError(
                  new SessionError(
                    "Failed to respond to skill challenge",
                    err instanceof Error ? err : undefined,
                  ),
                );
              }),
            ),
          ),
      );
    }
  }

  private handleMessage(data: MessageReceivedEvent): void {
    const message = data.message as Message;
    const key = this.reverseConvMap.get(message.conversationId);

    if (key && this.messageHandlers.has(key)) {
      const handler = this.messageHandlers.get(key)!;
      this.trackFork(
        this.runUserHandler(() => handler(message), {
          code: "HANDLER_ERROR",
          message: `Message handler for "${key}" threw`,
        }),
      );
    }

    if (this.messageHandlers.has("*")) {
      const handler = this.messageHandlers.get("*")!;
      this.trackFork(
        this.runUserHandler(() => handler(message), {
          code: "HANDLER_ERROR",
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
    ctx: { code: string; message: string },
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
          this.emitError(new AppError(ctx.code, ctx.message, err));
        }),
      ),
    );
  }

  private handleParticipantAdmitted(data: AppParticipantAdmittedEvent): void {
    for (const handler of this.participantAdmittedHandlers) {
      handler(data);
    }
  }

  private handleParticipantRejected(data: AppParticipantRejectedEvent): void {
    for (const handler of this.participantRejectedHandlers) {
      handler(data);
    }
  }

  private fireSessionReady(handle: AppSessionHandle): void {
    // Dedup: session can become active via both the apps/create result and
    // a subsequent app/sessionReady event — handlers must only fire once.
    if (this.firedSessionReady.has(handle.id)) return;
    this.firedSessionReady.add(handle.id);

    for (const handler of this.sessionReadyHandlers) {
      this.trackFork(
        this.runUserHandler(() => handler(handle), {
          code: "HANDLER_ERROR",
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
    return this.client
      .sendRpc("apps/getSession", { sessionId: session.id })
      .pipe(
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
                new SessionClosedError(
                  `Session ${session.id} closed during disconnect`,
                ),
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
              new SessionError(
                `Failed to recover session ${session.id} after reconnect`,
                err instanceof Error ? err : undefined,
              ),
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
    return this.client.sendRpc("system/ping", {}).pipe(
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
      this.logger.error(`[${error.code}] ${error.message}`);
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

/**
 * Map a `client.sendRpc` failure for `apps/attachConversation` onto the
 * SDK's typed `AttachError`. RPC server errors carry the server's reason
 * code in `data.code` (or `message`); transport / timeout errors collapse
 * to `AttachFailed`.
 */
type SendRpcError = NotConnectedError | RpcTimeoutError | RpcServerError;

function mapAttachError(err: SendRpcError): AttachError {
  if (err instanceof RpcServerError) {
    const code = extractAttachCode(err);
    return new AttachError(code, err.message, err);
  }
  // NotConnectedError or RpcTimeoutError — both extend Error via Data.TaggedError.
  const cause = err instanceof Error ? err : undefined;
  return new AttachError(
    "AttachFailed",
    `attachConversation failed: ${err.message}`,
    cause,
  );
}

/**
 * Numeric JSON-RPC error code → `AttachErrorCode` mapping. Matches the
 * server's `ErrorCodes` table (see `packages/protocol/src/schema/errors.ts`)
 * — kept inline (no protocol import) because the SDK already pins
 * `@moltzap/protocol` for context types and re-importing the constants
 * would make the SDK fail closed if the server ever renames a code
 * without matching downstream support; an inline table is one explicit
 * boundary that stays in sync via the integration test for
 * `apps/attachConversation` happy + error paths.
 */
const NumericCodeToAttach: Record<number, AttachErrorCode> = {
  [-32021]: "SessionNotFound", // ErrorCodes.SessionNotFound
  [-32002]: "ConversationNotFound", // ErrorCodes.NotFound (used for missing convId)
  [-32001]: "NotAuthorized", // ErrorCodes.Forbidden
};

function extractAttachCode(err: RpcServerError): AttachErrorCode {
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
      c === "NotAuthorized"
    ) {
      return c;
    }
  }

  // 3. Last-ditch substring fallback for legacy text-only RPC errors.
  if (err.message.includes("SessionNotFound")) return "SessionNotFound";
  if (err.message.includes("ConversationNotFound")) {
    return "ConversationNotFound";
  }
  if (err.message.includes("NotAuthorized")) return "NotAuthorized";

  return "AttachFailed";
}
