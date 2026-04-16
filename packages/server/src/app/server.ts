import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
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
import { AppHost, DefaultPermissionService } from "./app-host.js";
import type { AsyncWebhookAdapter } from "../adapters/webhook.js";

import type {
  CoreConfig,
  CoreApp,
  ConnectionHook,
  DisconnectionHook,
} from "./types.js";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createCoreApp(config: CoreConfig): CoreApp {
  const db = config.db;

  // Infrastructure
  const connections = new ConnectionManager();
  const broadcaster = new Broadcaster(connections);
  const envelope = config.encryptionMasterSecret
    ? new EnvelopeEncryption(config.encryptionMasterSecret)
    : null;

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

  const defaultPermissionService = new DefaultPermissionService(
    broadcaster,
    logger,
  );
  appHost.setPermissionService(defaultPermissionService);

  // Per-request connection context for concurrent WebSocket RPC dispatches
  const connIdContext = new AsyncLocalStorage<string>();

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
      permissionService: defaultPermissionService,
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

  // Agent registration — skipped when the app wants its own invite-gated
  // route. Set `skipDefaultRegisterRoute: true` in CoreConfig to opt out.
  if (!config.skipDefaultRegisterRoute) {
    app.post("/api/v1/auth/register", async (c) => {
      const body = await c.req.json();
      if (!validators.registerParams(body)) {
        return c.json({ error: "Invalid parameters" }, 400);
      }

      if (config.registrationSecret) {
        const inviteCode = (body as { inviteCode?: string }).inviteCode;
        if (!inviteCode || !safeEqual(inviteCode, config.registrationSecret)) {
          return c.json({ error: "Invalid or missing invite code" }, 403);
        }
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
  }

  // Permissions callback for async webhook flow
  app.post("/api/v1/permissions/resolve", async (c) => {
    if (!_webhookPermAdapter) {
      return c.json({ error: "Webhook permissions not configured" }, 404);
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !_callbackToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    if (!safeEqual(token, _callbackToken)) {
      return c.json({ error: "Invalid callback token" }, 401);
    }

    const body = (await c.req.json()) as {
      request_id?: string;
      access?: string[];
    };
    if (!body.request_id || !Array.isArray(body.access)) {
      return c.json(
        { error: "Invalid body: need request_id and access[]" },
        400,
      );
    }

    const found = _webhookPermAdapter.resolveCallback(
      body.request_id,
      body.access,
    );
    if (!found) {
      return c.json({ error: "Unknown or expired request_id" }, 404);
    }

    return c.json({ ok: true });
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
            const ownerUserId = conn.auth.ownerUserId;
            const agentRow = await db
              .selectFrom("agents")
              .select("name")
              .where("id", "=", agentId)
              .executeTakeFirst();
            const agentName = agentRow?.name ?? agentId;
            for (const hook of connectionHooks) {
              try {
                await hook({ agentId, agentName, ownerUserId, connId });
              } catch (err) {
                logger.error({ err, agentId, connId }, "Connection hook error");
              }
            }
          }
        },

        async onClose() {
          const conn = connections.get(connId);
          if (conn?.auth) {
            const { agentId, ownerUserId } = conn.auth;
            presenceService.setOffline(agentId);
            // Fire disconnection hooks (after auth was established).
            // Hooks run concurrently; errors log but don't block cleanup.
            for (const hook of disconnectionHooks) {
              try {
                await hook({ agentId, ownerUserId, connId });
              } catch (err) {
                logger.error(
                  { err, agentId, connId },
                  "Disconnection hook error",
                );
              }
            }
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
    onDisconnection(hook: DisconnectionHook) {
      disconnectionHooks.push(hook);
    },
    registerApp(manifest) {
      appHost.registerApp(manifest);
    },
    setUserService(service) {
      appHost.setUserService(service);
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
    async createAppSession(appId, initiatorAgentId, invitedAgentIds) {
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
    async closeAppSession(sessionId, callerAgentId) {
      return appHost.closeSession(sessionId, callerAgentId);
    },
    async getAppSession(sessionId, callerAgentId) {
      return appHost.getSession(sessionId, callerAgentId);
    },
    async listAppSessions(callerAgentId, opts) {
      return appHost.listSessions(callerAgentId, opts);
    },
    async close() {
      _webhookPermAdapter?.destroy();
      defaultPermissionService.destroy();
      appHost.destroy();
      for (const conn of connections.all()) {
        try {
          conn.ws.close();
        } catch (err) {
          logger.warn({ err }, "Failed to close WebSocket on shutdown");
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      server.close();
      if (config.dbCleanup) {
        await config.dbCleanup();
      }
    },
  };
}
