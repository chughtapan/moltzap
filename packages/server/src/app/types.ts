import type { Hono } from "hono";
import type { Kysely } from "kysely";
import type { RpcMethodDef } from "../rpc/context.js";
import type { AppManifest, AppSession } from "@moltzap/protocol";
import type { Database } from "../db/database.js";
import type { ContactService, PermissionService } from "./app-host.js";
import type { UserService } from "../services/user.service.js";
import type { AsyncWebhookAdapter } from "../adapters/webhook.js";
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
   * When true, core does not mount its default /api/v1/auth/register route.
   * Apps that want their own invite-gated / rate-limited register flow should
   * set this and mount their own handler. Contributes to chughtapan/moltzap's
   * extension API; a future PR pushes this upstream.
   */
  skipDefaultRegisterRoute?: boolean;
  /**
   * Fire-and-forget HTTP webhook after message delivery with the list of
   * offline recipient agent IDs. Use to drive push notifications or analytics
   * out of band. Body is signed with HMAC-SHA256 in the
   * `X-MoltZap-Signature: sha256=<hex>` header using `secret`.
   *
   * Shape:
   * ```json
   * { "conversationId": "uuid", "messageId": "uuid", "offlineRecipientAgentIds": ["uuid", ...] }
   * ```
   *
   * 3 retries with exponential backoff (1s/2s/4s). Failures log + drop —
   * never block `messages/send`.
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
  app: Hono;
  readonly port: number;
  registerRpcMethod: (name: string, def: RpcMethodDef) => void;
  onConnection: (hook: ConnectionHook) => void;
  /**
   * Fires when a WebSocket closes, after auth was established. Use for
   * per-user cleanup (e.g., `last_seen_at` updates). Does not fire for
   * connections that never authenticated.
   */
  onDisconnection: (hook: DisconnectionHook) => void;
  registerApp: (manifest: AppManifest) => void;
  setUserService: (service: UserService) => void;
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
  ) => Promise<AppSession>;
  onBeforeMessageDelivery: (
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ) => void;
  onAppJoin: (appId: string, handler: OnJoinHook) => void;
  onSessionClose: (appId: string, handler: OnCloseHook) => void;
  closeAppSession: (
    sessionId: string,
    callerAgentId: string,
  ) => Promise<{ closed: boolean }>;
  getAppSession: (
    sessionId: string,
    callerAgentId: string,
  ) => Promise<AppSession>;
  listAppSessions: (
    callerAgentId: string,
    opts?: { appId?: string; status?: string; limit?: number },
  ) => Promise<AppSession[]>;
  close: () => Promise<void>;
}
