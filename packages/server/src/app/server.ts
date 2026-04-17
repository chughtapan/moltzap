import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

import { logger, LoggerLive } from "../logger.js";
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

import {
  WebhookClient,
  type AsyncWebhookAdapter,
} from "../adapters/webhook.js";

import type { CoreConfig, CoreApp, ConnectionHook } from "./types.js";
import {
  DbTag,
  LoggerTag,
  EncryptionTag,
  ServicesLive,
  UserServiceTag,
  WebhookClientTag,
  resolveServices,
} from "./layers.js";

/** Grace period after closing all WebSockets so in-flight sends can flush. */
const SHUTDOWN_DRAIN_MS = 500;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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
    Layer.succeed(LoggerTag, logger),
    Layer.succeed(EncryptionTag, envelope),
    Layer.succeed(UserServiceTag, config.userService ?? null),
    Layer.succeed(WebhookClientTag, webhookClient),
    // LoggerLive replaces Effect's default console logger with the Pino-backed
    // Effect logger so `Effect.log*` inside services routes through Pino.
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
  } = services;

  appHost.setPermissionService(defaultPermissionService);

  // Connection hooks
  const connectionHooks: ConnectionHook[] = [];

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
    }),
    ...createConversationHandlers({
      conversationService,
      broadcaster,
      connections,
    }),
    ...createMessageHandlers({
      messageService,
      conversationService,
    }),
    ...createPresenceHandlers({
      presenceService,
      connections,
    }),
    ...createAppHandlers({
      appHost,
      permissionService: defaultPermissionService,
    }),
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

      const found = _webhookPermAdapter.resolveCallback(
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

  const httpApp = HttpRouter.empty.pipe(
    healthRoute,
    registerRoute,
    permissionsResolveRoute,
    HttpMiddleware.cors({
      allowedOrigins: allowedOriginsPredicate,
    }),
  );

  // Build a Node (req, res) handler from the Effect HttpApp.
  // We manage the http.Server ourselves so we can attach the WS upgrade hook.
  // LoggerLive is included so Effect.log* calls inside HTTP routes flow
  // through Pino (matching the WS/RPC dispatch path).
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(NodeHttpServer.layerContext, LoggerLive),
  );

  // Synchronously produce the Node handler. `makeHandler` only needs a Runtime.
  const makeHandlerEffect = NodeHttpServer.makeHandler(httpApp);
  const nodeHandler = runtime.runSync(makeHandlerEffect);

  // ── WebSocket via raw `ws` package + Node `upgrade` event ────────────

  const wss = new WebSocketServer({ noServer: true });

  function handleWsConnection(ws: WsWebSocket): void {
    const connId = crypto.randomUUID();

    connections.add({
      id: connId,
      ws,
      auth: null,
      lastPong: Date.now(),
      conversationIds: new Set(),
      mutedConversations: new Set(),
    });
    logger.info({ connId }, "WebSocket connected");

    // Per-connection counter for malformed-frame logging rate-limit.
    // Mirrors the client-side `MALFORMED_LOG_EVERY` pattern so a buggy
    // or hostile client can't flood the server log.
    let malformedFrameCount = 0;
    const MALFORMED_LOG_EVERY = 50;

    // #ignore-sloppy-code-next-line[async-keyword]: ws library message handler
    ws.on("message", async (data) => {
      const conn = connections.get(connId);
      if (!conn) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        const n = ++malformedFrameCount;
        if (n === 1 || n % MALFORMED_LOG_EVERY === 0) {
          logger.warn(
            { err, connId, count: n },
            "Failed to parse WebSocket frame",
          );
        }
        try {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              type: "response",
              id: null,
              error: {
                code: ErrorCodes.ParseError,
                message: "Invalid JSON",
              },
            }),
          );
        } catch (err) {
          logger.warn({ err, connId }, "ws.send failed");
        }
        return;
      }

      if (!validators.requestFrame(parsed)) {
        const id =
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { id?: unknown }).id === "string"
            ? (parsed as { id: string }).id
            : null;
        try {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              type: "response",
              id,
              error: {
                code: ErrorCodes.InvalidRequest,
                message: "Invalid request frame",
              },
            }),
          );
        } catch (err) {
          logger.warn({ err, connId }, "ws.send failed");
        }
        return;
      }

      const frame = parsed as RequestFrame;

      if (frame.method !== "auth/connect" && !conn.auth) {
        try {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              type: "response",
              id: frame.id,
              error: {
                code: ErrorCodes.Unauthorized,
                message: "Not authenticated. Send auth/connect first.",
              },
            }),
          );
        } catch (err) {
          logger.warn({ err, connId }, "ws.send failed");
        }
        return;
      }

      const ctx = conn.auth ?? ({} as AuthenticatedContext);
      const response = await dispatch(frame, ctx, connId);
      try {
        ws.send(JSON.stringify(response));
      } catch (err) {
        logger.warn({ err, connId }, "ws.send failed");
      }

      // Fire connection hooks after successful auth/connect
      if (frame.method === "auth/connect" && conn.auth) {
        const agentId = conn.auth.agentId;
        const agentRow = await db
          .selectFrom("agents")
          .select("name")
          .where("id", "=", agentId)
          .executeTakeFirst();
        const agentName = agentRow?.name ?? agentId;
        for (const hook of connectionHooks) {
          try {
            await hook({ agentId, agentName, connId });
          } catch (err) {
            logger.error({ err, agentId, connId }, "Connection hook error");
          }
        }
      }
    });

    ws.on("close", () => {
      const conn = connections.get(connId);
      if (conn?.auth) {
        presenceService.setOffline(conn.auth.agentId);
      }
      presenceService.removeConnection(connId);
      connections.remove(connId);
      logger.info({ connId }, "WebSocket disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err, connId }, "WebSocket error");
    });
  }

  // ── HTTP server with WS upgrade hook ──────────────────────────────────

  const server = http.createServer(nodeHandler);

  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = request.url ?? "";
      // Match only /ws (ignore query strings)
      const pathOnly = url.split("?")[0];
      if (pathOnly !== "/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleWsConnection(ws);
      });
    },
  );

  let actualPort = config.port;
  server.listen(config.port, () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      actualPort = addr.port;
    }
    logger.info({ port: actualPort }, "MoltZap core server listening");
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
    onAppJoin(appId, handler) {
      appHost.onAppJoin(appId, handler);
    },
    onSessionClose(appId, handler) {
      appHost.onSessionClose(appId, handler);
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
    // #ignore-sloppy-code-next-line[async-keyword]: ws library server close method
    async close() {
      _webhookPermAdapter?.destroy();
      defaultPermissionService.destroy();
      // NOTE: appHost.destroy() runs before the WS connections close, so
      // any RPC in-flight at this moment (mid-createSession, mid-send)
      // may observe cleared manifests / conversationToSession maps and
      // surface AppNotFound or undefined lookups. The SHUTDOWN_DRAIN_MS
      // sleep below is our only mitigation; it's not a real drain since
      // there's no counter. A proper fix would invert the order and
      // await an in-flight counter before destroy(). Tracked in /review
      // output 2026-04-16.
      appHost.destroy();
      // Close all WS connections first so in-flight message handlers stop
      for (const conn of connections.all()) {
        try {
          conn.ws.close();
        } catch (err) {
          logger.warn({ err }, "Failed to close WebSocket on shutdown");
        }
      }
      // Close the WS server (stops accepting new upgrades)
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      // Let in-flight requests drain briefly
      await new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_MS));
      // Close HTTP listener
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // Dispose the Effect runtime
      await runtime.dispose();
      if (config.dbCleanup) {
        await config.dbCleanup();
      }
    },
  };
}
