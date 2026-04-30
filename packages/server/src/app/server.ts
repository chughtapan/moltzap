import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import * as Socket from "@effect/platform/Socket";
import { NodeHttpServer } from "@effect/platform-node";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";

import { logger, LoggerLive } from "../logger.js";
import { NoopTraceCaptureLive } from "../runtime-surface/trace-capture.js";
import { createRpcRouter } from "../rpc/router.js";
import type {
  AuthenticatedContext,
  RpcMethodRegistry,
} from "../rpc/context.js";
import type { RequestFrame } from "@moltzap/protocol";
import { ErrorCodes, validators } from "@moltzap/protocol";
import { EnvelopeEncryption } from "../crypto/envelope.js";

// Handlers
import { createCoreAuthHandlers } from "./handlers/auth.handlers.js";
import { createConversationHandlers } from "./handlers/conversations.handlers.js";
import { createMessageHandlers } from "./handlers/messages.handlers.js";
import { createPresenceHandlers } from "./handlers/presence.handlers.js";
import { createAppHandlers } from "./handlers/apps.handlers.js";
import { createSystemHandlers } from "./handlers/system.handlers.js";

import {
  WebhookClient,
  type AsyncWebhookAdapter,
} from "../adapters/webhook.js";

import type {
  CoreConfig,
  CoreApp,
  ConnectionHook,
  DisconnectionHook,
} from "./types.js";
import {
  DbTag,
  DeliveryWebhookTag,
  EncryptionTag,
  ServicesLive,
  UserServiceTag,
  WebhookClientTag,
  resolveServices,
} from "./layers.js";

/** Grace period after closing all WebSockets so in-flight sends can flush. */
const SHUTDOWN_DRAIN_MS = 500;

const UTF8_DECODER = new TextDecoder("utf-8");

/** Per-connection malformed-frame log rate-limit. Mirrors the client-side
 * pattern so a buggy/hostile peer can't flood the server log. */
const MALFORMED_LOG_EVERY = 50;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const USER_HOOK_TIMEOUT_MS = 2_000;

function runUserHook<TArgs>(
  hook: (args: TArgs) => void | Promise<void>,
  args: TArgs,
  label: string,
  logCtx: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(hook(args)),
    catch: (err) => err,
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(USER_HOOK_TIMEOUT_MS),
      onTimeout: () => new Error(`${label} timed out`),
    }),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        logger.error({ err, ...logCtx }, `${label} error`);
      }),
    ),
  );
}

export function createCoreApp(config: CoreConfig): CoreApp {
  const db = config.db;

  // ── Service construction via Effect Layers ──────────────────────────
  // Declarative replacement for the previous `new XxxService(db, logger)`
  // chain. Dependency order is encoded in each Layer's `yield*` — not
  // hand-written here — so adding a new service only requires a new Tag
  // + Layer in layers.ts, no edits to this function.
  const envelope = config.encryptionMasterSecret
    ? new EnvelopeEncryption(config.encryptionMasterSecret)
    : null;

  // A single shared WebhookClient instance handles all outbound HTTP from
  // the core: AppHost hook webhooks, plus any contact/user-service adapters
  // layered on top via `setContactService` etc. One semaphore means one
  // place to tune concurrency.
  const webhookClient = config.webhookClient ?? new WebhookClient();

  const BaseLive = Layer.mergeAll(
    Layer.succeed(DbTag, db),
    Layer.succeed(EncryptionTag, envelope),
    Layer.succeed(UserServiceTag, config.userService ?? null),
    Layer.succeed(WebhookClientTag, webhookClient),
    Layer.succeed(DeliveryWebhookTag, config.deliveryWebhook ?? null),
    config.traceCaptureLayer ?? NoopTraceCaptureLive,
    // Provides LoggerTag (pino built from Effect.Config) and replaces the
    // default Effect logger so `Effect.log*` routes through the same stream.
    LoggerLive,
  );

  // provideMerge (vs provide): BaseLive satisfies ServicesLive's Db/Logger/
  // Encryption requirements AND exposes them downstream, so resolveServices
  // can also pull db/logger/encryption from Context without a separate Layer.
  const FullLive = Layer.provideMerge(ServicesLive, BaseLive);

  const services = Effect.runSync(
    resolveServices.pipe(Effect.provide(FullLive)),
  );

  const {
    connections,
    broadcaster,
    authService,
    conversationService,
    presenceService,
    messageService,
    appHost,
    defaultPermissionService,
    traceCapture,
  } = services;

  appHost.setPermissionService(defaultPermissionService);

  // Connection hooks
  const connectionHooks: ConnectionHook[] = [];
  const disconnectionHooks: DisconnectionHook[] = [];

  // Webhook permission callback state (set via setWebhookPermissionCallback)
  let _webhookPermAdapter: AsyncWebhookAdapter | null = null;
  let _callbackToken: string | null = null;

  // Mutable RPC method registry — core handlers + extension methods
  const methods: RpcMethodRegistry = {
    ...createCoreAuthHandlers({
      authService,
      conversationService,
      presenceService,
      connections,
      db,
      userService: config.userService ?? null,
    }),
    ...createConversationHandlers({
      conversationService,
      broadcaster,
      connections,
    }),
    ...createMessageHandlers({
      messageService,
      conversationService,
      db,
    }),
    ...createPresenceHandlers({
      presenceService,
      connections,
    }),
    ...createAppHandlers({
      appHost,
      permissionService: defaultPermissionService,
    }),
    ...createSystemHandlers(),
  };

  const dispatch = createRpcRouter(methods);

  // ── HTTP routes via @effect/platform HttpRouter ──────────────────────

  const healthRoute = HttpRouter.get(
    "/health",
    Effect.sync(() =>
      HttpServerResponse.unsafeJson({
        status: "ok",
        connections: connections.size,
      }),
    ),
  );

  const registerRoute = HttpRouter.post(
    "/api/v1/auth/register",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bodyResult = yield* Effect.either(request.json);
      if (bodyResult._tag === "Left") {
        return HttpServerResponse.unsafeJson(
          { error: "Invalid JSON" },
          { status: 400 },
        );
      }
      const body = bodyResult.right;

      if (!validators.registerParams(body)) {
        return HttpServerResponse.unsafeJson(
          { error: "Invalid parameters" },
          { status: 400 },
        );
      }

      if (config.registrationSecret) {
        const inviteCode = (body as { inviteCode?: string }).inviteCode;
        if (!inviteCode || !safeEqual(inviteCode, config.registrationSecret)) {
          return HttpServerResponse.unsafeJson(
            { error: "Invalid or missing invite code" },
            { status: 403 },
          );
        }
      }

      const exit = yield* Effect.exit(
        authService.registerAgent(
          body as Parameters<typeof authService.registerAgent>[0],
          config.devModeUserId,
        ),
      );
      if (Exit.isSuccess(exit)) {
        return HttpServerResponse.unsafeJson(exit.value, { status: 201 });
      }
      // registerAgent's error channel is `never` — any failure here is a defect
      // (DB error, etc.) which maps to a 500.
      logger.error({ cause: Cause.pretty(exit.cause) }, "Registration failed");
      return HttpServerResponse.unsafeJson(
        { error: "Registration failed" },
        { status: 500 },
      );
    }),
  );

  const permissionsResolveRoute = HttpRouter.post(
    "/api/v1/permissions/resolve",
    Effect.gen(function* () {
      if (!_webhookPermAdapter) {
        return HttpServerResponse.unsafeJson(
          { error: "Webhook permissions not configured" },
          { status: 404 },
        );
      }

      const request = yield* HttpServerRequest.HttpServerRequest;
      const authHeader = request.headers["authorization"];
      if (!authHeader || !_callbackToken) {
        return HttpServerResponse.unsafeJson(
          { error: "Unauthorized" },
          { status: 401 },
        );
      }
      const token = authHeader.replace("Bearer ", "");
      if (!safeEqual(token, _callbackToken)) {
        return HttpServerResponse.unsafeJson(
          { error: "Invalid callback token" },
          { status: 401 },
        );
      }

      const bodyResult = yield* Effect.either(request.json);
      if (bodyResult._tag === "Left") {
        return HttpServerResponse.unsafeJson(
          { error: "Invalid JSON" },
          { status: 400 },
        );
      }
      const body = bodyResult.right as {
        request_id?: string;
        access?: string[];
      };
      if (!body.request_id || !Array.isArray(body.access)) {
        return HttpServerResponse.unsafeJson(
          { error: "Invalid body: need request_id and access[]" },
          { status: 400 },
        );
      }

      const found = yield* _webhookPermAdapter.resolveCallback(
        body.request_id,
        body.access,
      );
      if (!found) {
        return HttpServerResponse.unsafeJson(
          { error: "Unknown or expired request_id" },
          { status: 404 },
        );
      }

      return HttpServerResponse.unsafeJson({ ok: true });
    }),
  );

  const allowedOriginsPredicate = (origin: string): boolean => {
    if (config.corsOrigins.includes("*")) return true;
    if (config.corsOrigins.includes(origin)) return true;
    logger.warn({ origin }, "CORS origin rejected");
    return false;
  };

  /** Handle a freshly-upgraded socket: auth/connect → RPC dispatch → close.
   * Lives inside the per-request fiber; returning exits the connection. */
  const handleSocket = (
    socket: Socket.Socket,
  ): Effect.Effect<void, Socket.SocketError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const connId = crypto.randomUUID();
        const writer = yield* socket.writer;
        const closeRequested = yield* Deferred.make<void>();

        let malformedFrameCount = 0;

        const write = (raw: string) => writer(raw);
        const sendFrame = (obj: unknown) =>
          write(JSON.stringify(obj)).pipe(
            Effect.catchAll((err) =>
              Effect.sync(() =>
                logger.warn({ err, connId }, "socket write failed"),
              ),
            ),
          );

        connections.add({
          id: connId,
          write,
          shutdown: Deferred.succeed(closeRequested, undefined).pipe(
            Effect.asVoid,
          ),
          auth: null,
          lastPong: Date.now(),
          conversationIds: new Set(),
          mutedConversations: new Set(),
        });
        logger.info({ connId }, "WebSocket connected");

        const handleFrame = (raw: string) =>
          Effect.gen(function* () {
            const conn = connections.get(connId);
            if (!conn) return;

            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              const n = ++malformedFrameCount;
              if (n === 1 || n % MALFORMED_LOG_EVERY === 0) {
                logger.warn(
                  { err, connId, count: n },
                  "Failed to parse WebSocket frame",
                );
              }
              yield* sendFrame({
                jsonrpc: "2.0",
                type: "response",
                id: null,
                error: {
                  code: ErrorCodes.ParseError,
                  message: "Invalid JSON",
                },
              });
              return;
            }

            if (!validators.requestFrame(parsed)) {
              const id =
                typeof parsed === "object" &&
                parsed !== null &&
                typeof (parsed as { id?: unknown }).id === "string"
                  ? (parsed as { id: string }).id
                  : null;
              yield* sendFrame({
                jsonrpc: "2.0",
                type: "response",
                id,
                error: {
                  code: ErrorCodes.InvalidRequest,
                  message: "Invalid request frame",
                },
              });
              return;
            }

            const frame = parsed as RequestFrame;
            if (frame.method !== "auth/connect" && !conn.auth) {
              yield* sendFrame({
                jsonrpc: "2.0",
                type: "response",
                id: frame.id,
                error: {
                  code: ErrorCodes.Unauthorized,
                  message: "Not authenticated. Send auth/connect first.",
                },
              });
              return;
            }

            const ctx = conn.auth ?? ({} as AuthenticatedContext);
            const response = yield* Effect.tryPromise({
              try: () => dispatch(frame, ctx, connId),
              catch: (err) => err,
            }).pipe(
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  logger.error({ err, connId }, "RPC dispatch failed");
                  return {
                    jsonrpc: "2.0",
                    type: "response",
                    id: frame.id,
                    error: {
                      code: ErrorCodes.InternalError,
                      message: "Internal error",
                    },
                  };
                }),
              ),
            );
            yield* sendFrame(response);

            // Fire connection hooks after a successful auth/connect — auth was
            // populated by the dispatch handler if the credentials were valid.
            if (frame.method === "auth/connect") {
              const authCtx = connections.get(connId)?.auth;
              if (!authCtx) return;
              const { agentId, ownerUserId } = authCtx;
              const agentRow = yield* Effect.tryPromise(() =>
                db
                  .selectFrom("agents")
                  .select("name")
                  .where("id", "=", agentId)
                  .executeTakeFirst(),
              ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
              const agentName = agentRow?.name ?? agentId;
              for (const hook of connectionHooks) {
                yield* runUserHook(
                  hook,
                  { agentId, agentName, ownerUserId, connId },
                  "Connection hook",
                  { agentId, connId },
                );
              }
            }
          });

        const reader = socket.runRaw((data) =>
          handleFrame(
            typeof data === "string" ? data : UTF8_DECODER.decode(data),
          ),
        );

        // `raceFirst` so an abnormal close (reader fails before anyone calls
        // `conn.shutdown`) doesn't hang on the still-pending `closeRequested`.
        // With `race`, onExit never fires on abrupt disconnects and the
        // connection leaks in the manager.
        yield* Effect.raceFirst(reader, Deferred.await(closeRequested)).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const conn = connections.get(connId);
              const authCtx = conn?.auth ?? null;
              if (authCtx) presenceService.setOffline(authCtx.agentId);
              // Run sequentially so an earlier hook's cleanup (e.g.
              // `last_seen_at`) completes before the next hook observes
              // the post-close state.
              if (authCtx) {
                const { agentId, ownerUserId } = authCtx;
                for (const hook of disconnectionHooks) {
                  yield* runUserHook(
                    hook,
                    { agentId, ownerUserId, connId },
                    "Disconnection hook",
                    { agentId, connId },
                  );
                }
              }
              presenceService.removeConnection(connId);
              connections.remove(connId);
              if (Exit.isFailure(exit)) {
                logger.warn(
                  { connId, cause: Cause.pretty(exit.cause) },
                  "WebSocket error",
                );
              }
              logger.info({ connId }, "WebSocket disconnected");
            }),
          ),
        );
      }),
    );

  const wsRoute = HttpRouter.get(
    "/ws",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* req.upgrade;
      yield* handleSocket(socket);
      return HttpServerResponse.empty();
    }).pipe(
      Effect.catchAll((err) => {
        logger.warn({ err }, "WS upgrade failed");
        return HttpServerResponse.empty({ status: 400 });
      }),
    ),
  );

  // `skipDefaultRegisterRoute` lets apps opt out of core's default register
  // handler so they can mount their own invite-gated / rate-limited flow.
  const httpApp = (
    config.skipDefaultRegisterRoute
      ? HttpRouter.empty.pipe(healthRoute, permissionsResolveRoute, wsRoute)
      : HttpRouter.empty.pipe(
          healthRoute,
          registerRoute,
          permissionsResolveRoute,
          wsRoute,
        )
  ).pipe(
    HttpMiddleware.cors({
      allowedOrigins: allowedOriginsPredicate,
    }),
  );

  // Server lifecycle: `NodeHttpServer.make` acquires an http.Server inside a
  // Scope we own (`appScope`); closing the scope on shutdown tears down the
  // listener, the wired upgrade handler, and any per-connection fibers.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(NodeHttpServer.layerContext, LoggerLive),
  );
  const appScope = Effect.runSync(Scope.make());

  let actualPort = config.port;
  const startup = Effect.gen(function* () {
    const serverSvc = yield* NodeHttpServer.make(() => http.createServer(), {
      port: config.port,
      host: "0.0.0.0",
    });
    yield* serverSvc.serve(httpApp);
    const addr = serverSvc.address;
    actualPort = addr._tag === "TcpAddress" ? addr.port : config.port;
    logger.info({ port: actualPort }, "MoltZap core server listening");
  }).pipe(Scope.extend(appScope));

  runtime.runPromise(startup).catch((err) => {
    logger.error({ err }, "Server startup failed");
  });

  return {
    get port() {
      return actualPort;
    },
    registerRpcMethod(name: string, def) {
      methods[name] = def;
    },
    onConnection(hook: ConnectionHook) {
      connectionHooks.push(hook);
    },
    onDisconnection(hook: DisconnectionHook) {
      disconnectionHooks.push(hook);
    },
    broadcaster,
    traceCapture,
    connections,
    registerApp(manifest) {
      appHost.registerApp(manifest);
    },
    setContactService(checker) {
      appHost.setContactService(checker);
    },
    setPermissionService(handler) {
      appHost.setPermissionService(handler);
    },
    setWebhookPermissionCallback(adapter, token) {
      _webhookPermAdapter = adapter;
      _callbackToken = token;
    },
    createAppSession(appId, initiatorAgentId, invitedAgentIds) {
      return appHost.createSession(appId, initiatorAgentId, invitedAgentIds);
    },
    onBeforeMessageDelivery(appId, handler) {
      appHost.onBeforeMessageDelivery(appId, handler);
    },
    onBeforeDispatch(appId, handler) {
      appHost.onBeforeDispatch(appId, handler);
    },
    onAppJoin(appId, handler) {
      appHost.onAppJoin(appId, handler);
    },
    onSessionClose(appId, handler) {
      appHost.onSessionClose(appId, handler);
    },
    onSessionActive(appId, handler) {
      appHost.onSessionActive(appId, handler);
    },
    closeAppSession(sessionId, callerAgentId) {
      return appHost.closeSession(sessionId, callerAgentId);
    },
    getAppSession(sessionId, callerAgentId) {
      return appHost.getSession(sessionId, callerAgentId);
    },
    listAppSessions(callerAgentId, opts) {
      return appHost.listSessions(callerAgentId, opts);
    },
    attachAppConversation(sessionId, conversationId, key) {
      return appHost.attachConversation(sessionId, conversationId, key);
    },
    // #ignore-sloppy-code-next-line[async-keyword]: server close is a Promise boundary for external callers
    async close() {
      if (_webhookPermAdapter) {
        await Effect.runPromise(_webhookPermAdapter.shutdown);
      }
      defaultPermissionService.destroy();
      // Interrupt in-flight delivery-webhook retries before scope close so
      // pending POSTs don't race the HTTP server teardown.
      await Effect.runPromise(messageService.close());
      // `appHost.destroy()` runs before connections close, so any RPC
      // in-flight may observe cleared manifests. The drain sleep below is
      // the only mitigation today — tracked in /review output 2026-04-16.
      appHost.destroy();
      for (const conn of connections.all()) {
        await Effect.runPromise(conn.shutdown);
      }
      await new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_MS));
      // Closing appScope tears down the http.Server + upgrade wiring.
      await Effect.runPromise(Scope.close(appScope, Exit.void));
      await runtime.dispose();
      if (config.dbCleanup) {
        await config.dbCleanup();
      }
    },
  };
}
