import type { Kysely } from "kysely";
import { Brand, type Layer } from "effect";
import type { RpcMethodBinding } from "../rpc/context.js";
import {
  agentId as makeAgentId,
  conversationId as makeConversationId,
  userId as makeUserId,
  type AppManifest,
  type Static,
} from "@moltzap/protocol";
import {
  AgentId as AgentIdSchema,
  ConversationId as ConversationIdSchema,
  UserId as UserIdSchema,
} from "@moltzap/protocol/schemas/primitives";
import type { Database } from "../db/database.js";
import type { ContactService } from "./app-host.js";
import type { UserService } from "../services/user.service.js";
import type { WebhookClient } from "../adapters/webhook.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type {
  BeforeMessageDeliveryHook,
  BeforeDispatchHook,
  OnCloseHook,
  OnSessionActiveHook,
} from "./hooks.js";
import type {
  TraceCapture,
  TraceCaptureTag,
} from "../runtime-surface/trace-capture.js";

export type UserId = Static<typeof UserIdSchema>;
export const UserId = makeUserId;

export type AgentId = Static<typeof AgentIdSchema>;
export const AgentId = makeAgentId;

export type ConversationId = Static<typeof ConversationIdSchema>;
export const ConversationId = makeConversationId;

export type AppId = string & Brand.Brand<"AppId">;
export const AppId = Brand.nominal<AppId>();

export interface CoreConfig {
  db: Kysely<Database>;
  dbCleanup?: () => PromiseLike<void>;
  encryptionMasterSecret?: string;
  port: number;
  corsOrigins: string[];
  registrationSecret?: string;
  devMode?: boolean;
  /**
   * When set, agents registered via the default `/api/v1/auth/register`
   * route are given this user id as their `owner_user_id`, skipping the
   * claim step. Intended for local dev / quickstart. Production MUST
   * leave this unset and perform claim through an external auth
   * provider (see docs/guides/custom-identity-provider.mdx).
   */
  devModeUserId?: string;
  /**
   * Optional webhook-backed user validator. When unset the server skips
   * user validation during app session admission (admits all users).
   */
  userService?: UserService;
  /**
   * Shared outbound HTTP client used for `MessageService.deliveryWebhook`
   * fanout and user-side adapters (contact/user services). If unset,
   * `createCoreApp` constructs a default `new WebhookClient()`. Tests may
   * inject a fake to intercept outbound HTTP.
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
  /**
   * Optional trace-capture layer override. When unset, the server runs with
   * the default no-op capture and emits no trace artifacts.
   */
  traceCaptureLayer?: Layer.Layer<TraceCaptureTag>;
}

export type ConnectionHook = (params: {
  agentId: string;
  agentName: string;
  /** Owner user ID resolved at auth/connect time. Null for unclaimed agents. */
  ownerUserId: string | null;
  connId: string;
}) => PromiseLike<void> | void;

export type DisconnectionHook = (params: {
  agentId: string;
  ownerUserId: string | null;
  connId: string;
}) => PromiseLike<void> | void;

export interface CoreApp {
  readonly port: number;
  registerRpcMethod: (method: RpcMethodBinding) => void;
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
  readonly traceCapture: TraceCapture;
  /**
   * Live ConnectionManager instance. Apps can query `getByParticipant` to
   * check whether an agent has any live connections (for presence-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;
  registerApp: (manifest: AppManifest) => void;
  /**
   * Register an app whose hook handlers run in a remote process,
   * connected over WebSocket. Hook RPCs (`apps/onBeforeDispatch`,
   * `onBeforeMessageDelivery`, `onSessionActive`, `onClose`)
   * route to `connectionId` via the server-initiated awaitable RPC
   * primitive. Verdicts decode at the WS edge into the same typed
   * shapes as in-process hooks (`DispatchAdmissionResult`, `HookResult`).
   *
   * The dispatch surface is uniform with in-process per architect plan
   * §3.4: callers of `runBeforeDispatch` etc. cannot observe whether a
   * given app is in-process or remote. Fail-closed verdicts on
   * disconnect / timeout / RPC error preserve the existing security
   * posture (see `30-app-hooks.integration.test.ts:229-272,296-357`).
   *
   * Promotes any prior in-process registration for the same `appId` —
   * the remote routing wins. Use {@link unregisterRemoteApp} to drop
   * the registration eagerly when a connection is known to be gone
   * (operator-driven cleanup; the disconnect-finalizer handles
   * in-flight Deferreds either way).
   */
  registerRemoteApp: (manifest: AppManifest, connectionId: string) => void;
  /**
   * Drop a remote-app registration. Idempotent. Does NOT remove the
   * manifest; only the routing entry. See {@link AppHost.unregisterRemoteApp}.
   */
  unregisterRemoteApp: (appId: string) => void;
  setContactService: (checker: ContactService) => void;
  onBeforeMessageDelivery: (
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ) => void;
  onBeforeDispatch: (appId: string, handler: BeforeDispatchHook) => void;
  onSessionClose: (appId: string, handler: OnCloseHook) => void;
  onSessionActive: (appId: string, handler: OnSessionActiveHook) => void;
  close: () => PromiseLike<void>;
}
