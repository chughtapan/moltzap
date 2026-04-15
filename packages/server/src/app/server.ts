import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { AsyncLocalStorage } from "node:async_hooks";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { logger } from "../logger.js";
import { ConnectionManager } from "../ws/connection.js";
import { Broadcaster } from "../ws/broadcaster.js";
import { createRpcRouter, RpcError } from "../rpc/router.js";
import type {
  AuthenticatedContext,
  RpcMethodRegistry,
} from "../rpc/context.js";
import type { RequestFrame } from "@moltzap/protocol";
import { ErrorCodes, validators } from "@moltzap/protocol";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import type { Database } from "../db/database.js";

// Services
import { AuthService } from "../services/auth.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { MessageService } from "../services/message.service.js";
import { DeliveryService } from "../services/delivery.service.js";
import { PresenceService } from "../services/presence.service.js";
import { ParticipantService } from "../services/participant.service.js";

// Handlers
import { createCoreAuthHandlers } from "./handlers/auth.handlers.js";
import { createConversationHandlers } from "./handlers/conversations.handlers.js";
import { createMessageHandlers } from "./handlers/messages.handlers.js";
import { createPresenceHandlers } from "./handlers/presence.handlers.js";
import { createAppHandlers } from "./handlers/apps.handlers.js";

// AppHost
import { AppHost, DefaultPermissionHandler } from "./app-host.js";

import type { CoreConfig, CoreApp, ConnectionHook } from "./types.js";
import { runDemoAgents } from "./demo-agents.js";

export function createCoreApp(config: CoreConfig): CoreApp {
  // Database pool
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected database pool error");
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  // Infrastructure
  const connections = new ConnectionManager();
  const broadcaster = new Broadcaster(connections);
  const envelope = new EnvelopeEncryption(config.encryptionMasterSecret);

  // Services
  const authService = new AuthService(db, logger);
  const participantService = new ParticipantService(db);
  const conversationService = new ConversationService(
    db,
    logger,
    participantService,
  );
  const deliveryService = new DeliveryService(db);
  const presenceService = new PresenceService();

  // AppHost (before MessageService — it needs the hook call)
  const appHost = new AppHost(
    db,
    broadcaster,
    connections,
    conversationService,
    logger,
  );

  const messageService = new MessageService(
    db,
    logger,
    conversationService,
    broadcaster,
    envelope,
    deliveryService,
    appHost,
  );

  const defaultPermissionHandler = new DefaultPermissionHandler(
    broadcaster,
    logger,
  );
  appHost.setPermissionHandler(defaultPermissionHandler);

  // Per-request connection context for concurrent WebSocket RPC dispatches
  const connIdContext = new AsyncLocalStorage<string>();

  // Connection hooks
  const connectionHooks: ConnectionHook[] = [];

  // Mutable RPC method registry — core handlers + extension methods from @moltzap/server
  const methods: RpcMethodRegistry = {
    ...createCoreAuthHandlers({
      authService,
      conversationService,
      presenceService,
      connections,
      db,
      getConnId: () => connIdContext.getStore() ?? "",
    }),
    ...createConversationHandlers({
      conversationService,
      broadcaster,
      connections,
      getConnId: () => connIdContext.getStore() ?? "",
    }),
    ...createMessageHandlers({
      messageService,
      conversationService,
      db,
      getConnId: () => connIdContext.getStore() ?? "",
    }),
    ...createPresenceHandlers({
      presenceService,
      connections,
      getConnId: () => connIdContext.getStore() ?? "",
    }),
    ...createAppHandlers({
      appHost,
      permissionHandler: defaultPermissionHandler,
    }),
  };

  const dispatch = createRpcRouter(methods);

  // Hono app
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (config.corsOrigins.includes("*")) return origin;
        if (config.corsOrigins.includes(origin)) return origin;
        logger.warn({ origin }, "CORS origin rejected");
        return "";
      },
    }),
  );

  app.get("/health", (c) =>
    c.json({ status: "ok", connections: connections.size }),
  );

  // Agent registration (no rate limiting, no invite code validation)
  app.post("/api/v1/auth/register", async (c) => {
    const body = await c.req.json();
    if (!validators.registerParams(body)) {
      return c.json({ error: "Invalid parameters" }, 400);
    }
    try {
      const result = await authService.registerAgent(body);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof RpcError) {
        const status = err.code === ErrorCodes.Forbidden ? 403 : 400;
        return c.json({ error: err.message }, status);
      }
      logger.error({ err }, "Registration failed");
      return c.json({ error: "Registration failed" }, 500);
    }
  });

  // WebSocket endpoint
  app.get(
    "/ws",
    upgradeWebSocket(() => {
      let connId: string;

      return {
        onOpen(_evt, ws) {
          connId = crypto.randomUUID();
          connections.add({
            id: connId,
            ws,
            auth: null,
            lastPong: Date.now(),
            conversationIds: new Set(),
            mutedConversations: new Set(),
          });
          logger.info({ connId }, "WebSocket connected");
        },

        async onMessage(evt, ws) {
          const conn = connections.get(connId);
          if (!conn) return;

          let frame: RequestFrame;
          try {
            const data =
              typeof evt.data === "string" ? evt.data : evt.data.toString();
            frame = JSON.parse(data);
          } catch (err) {
            logger.warn({ err, connId }, "Failed to parse WebSocket frame");
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
            return;
          }

          if (
            !frame.jsonrpc ||
            frame.jsonrpc !== "2.0" ||
            frame.type !== "request"
          ) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                type: "response",
                id: frame.id ?? null,
                error: {
                  code: ErrorCodes.InvalidRequest,
                  message: "Invalid request frame",
                },
              }),
            );
            return;
          }

          if (frame.method !== "auth/connect" && !conn.auth) {
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
            return;
          }

          const ctx = conn.auth ?? ({} as AuthenticatedContext);
          const response = await connIdContext.run(connId, async () =>
            dispatch(frame, ctx),
          );
          ws.send(JSON.stringify(response));

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
        },

        async onClose() {
          const conn = connections.get(connId);
          if (conn?.auth) {
            presenceService.setOffline(conn.auth.agentId);
          }
          presenceService.removeConnection(connId);
          connections.remove(connId);
          logger.info({ connId }, "WebSocket disconnected");
        },
      };
    }),
  );

  let actualPort = config.port;
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    actualPort = info.port;
    logger.info({ port: info.port }, "MoltZap core server listening");
  });

  injectWebSocket(server);

  if (config.devMode) {
    runDemoAgents({ db, authService, conversationService }).catch((err) =>
      logger.error(err, "Demo agent setup failed"),
    );
  }

  return {
    app,
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
    setContactChecker(checker) {
      appHost.setContactChecker(checker);
    },
    setPermissionHandler(handler) {
      appHost.setPermissionHandler(handler);
    },
    async createAppSession(appId, initiatorAgentId, invitedAgentIds) {
      return appHost.createSession(appId, initiatorAgentId, invitedAgentIds);
    },
    onBeforeMessageDelivery(appId, handler) {
      appHost.onBeforeMessageDelivery(appId, handler);
    },
    onAppJoin(appId, handler) {
      appHost.onAppJoin(appId, handler);
    },
    async close() {
      defaultPermissionHandler.destroy();
      appHost.destroy();
      for (const conn of connections.all()) {
        try {
          conn.ws.close();
        } catch (err) {
          logger.warn({ err }, "Failed to close WebSocket on shutdown");
        }
      }
      // Give in-flight handlers a moment to settle
      await new Promise((r) => setTimeout(r, 500));
      server.close();
      await db.destroy();
    },
  };
}
