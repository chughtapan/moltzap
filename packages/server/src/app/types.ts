import type { Kysely } from "kysely";
import type { Effect } from "effect";
import type { RpcMethodDef } from "../rpc/context.js";
import type { AppManifest, AppSession } from "@moltzap/protocol";
import type { Database } from "../db/database.js";
import type { ContactService, PermissionService } from "./app-host.js";
import type { RpcFailure } from "../runtime/index.js";
import type { UserService } from "../services/user.service.js";
import type {
  AsyncWebhookAdapter,
  WebhookClient,
} from "../adapters/webhook.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type {
  BeforeMessageDeliveryHook,
  OnCloseHook,
  OnJoinHook,
} from "./hooks.js";

export interface CoreConfig {
  db: Kysely<Database>;
  dbCleanup?: () => Promise<void>;
  encryptionMasterSecret?: string;
  port: number;
  corsOrigins: string[];
  registrationSecret?: string;
  devMode?: boolean;
  /**
   * Optional webhook-backed user validator. When unset the server skips
   * user validation during app session admission (admits all users).
   */
  userService?: UserService;
  /**
   * Shared outbound HTTP client for webhook dispatch (app hooks, contact
   * service, user service). If unset, `createCoreApp` constructs a default
   * `new WebhookClient()`. Tests may inject a fake to intercept outbound
   * HTTP.
   */
  webhookClient?: WebhookClient;
  /**
   * When true, core does not mount its default `/api/v1/auth/register`
   * route. Apps that want their own invite-gated / rate-limited register
   * flow set this and mount their own handler.
   */
  skipDefaultRegisterRoute?: boolean;
  /**
   * Fire-and-forget HTTP webhook after message delivery with the list of
   * offline recipient agent IDs. Use to drive push notifications or analytics
   * out of band. Body is signed with HMAC-SHA256 in the
   * `X-MoltZap-Signature: sha256=<hex>` header using `secret`.
   *
   * Shape: `{ conversationId, messageId, offlineRecipientAgentIds: string[] }`.
   *
   * Dispatched on a detached daemon fiber with a 3-attempt exponential backoff
   * (1s base, jittered). Failures log and drop — never block `messages/send`.
   */
  deliveryWebhook?: { url: string; secret: string };
}

export type ConnectionHook = (params: {
  agentId: string;
  agentName: string;
  /** Owner user ID resolved at auth/connect time. Null for unclaimed agents. */
  ownerUserId: string | null;
  connId: string;
}) => Promise<void> | void;

export type DisconnectionHook = (params: {
  agentId: string;
  ownerUserId: string | null;
  connId: string;
}) => Promise<void> | void;

export interface CoreApp {
  readonly port: number;
  registerRpcMethod: (name: string, def: RpcMethodDef) => void;
  onConnection: (hook: ConnectionHook) => void;
  /**
   * Fires when a WebSocket closes, after auth was established. Use for
   * per-user cleanup (e.g., `last_seen_at` updates). Does not fire for
   * connections that never authenticated.
   */
  onDisconnection: (hook: DisconnectionHook) => void;
  /**
   * Live Broadcaster instance. Apps that register custom RPCs and want to
   * emit events out-of-band (not via `broadcastToConversation`) use this to
   * `sendToAgent(agentId, event)`. Stable identity — same ref across the
   * server lifetime.
   */
  readonly broadcaster: Broadcaster;
  /**
   * Live ConnectionManager instance. Apps can query `getByParticipant` to
   * check whether an agent has any live connections (for presence-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;
  registerApp: (manifest: AppManifest) => void;
  setContactService: (checker: ContactService) => void;
  setPermissionService: (handler: PermissionService) => void;
  setWebhookPermissionCallback: (
    adapter: AsyncWebhookAdapter,
    token: string,
  ) => void;
  createAppSession: (
    appId: string,
    initiatorAgentId: string,
    invitedAgentIds: string[],
  ) => Effect.Effect<AppSession, RpcFailure>;
  onBeforeMessageDelivery: (
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ) => void;
  onAppJoin: (appId: string, handler: OnJoinHook) => void;
  onSessionClose: (appId: string, handler: OnCloseHook) => void;
  closeAppSession: (
    sessionId: string,
    callerAgentId: string,
  ) => Effect.Effect<{ closed: boolean }, RpcFailure>;
  getAppSession: (
    sessionId: string,
    callerAgentId: string,
  ) => Effect.Effect<AppSession, RpcFailure>;
  listAppSessions: (
    callerAgentId: string,
    opts?: { appId?: string; status?: string; limit?: number },
  ) => Effect.Effect<AppSession[], RpcFailure>;
  close: () => Promise<void>;
}
