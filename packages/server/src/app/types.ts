import type { Kysely } from "kysely";
import { Brand, type Layer } from "effect";
import type { RpcMethodBinding } from "../transport/context.js";
import type { AppManifest } from "@moltzap/protocol";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import type { Database } from "../db/database.js";
import type { ContactService } from "./app-host.js";
import type { SessionValidator } from "../identity/services/session-validator.js";
import type { WebhookClient } from "../adapters/webhook.js";
import type { ConnectionManager } from "../transport/connection.js";
import type { NetworkSendService } from "../network/network-send.js";
import type {
  MessageAuthorizeHook,
  TaskAuthorizeDispatchHook,
} from "./hooks.js";
import type { EndpointAddress } from "@moltzap/protocol/network";
import type { LeaseRegistry } from "./lease-registry.js";
import type {
  TraceCapture,
  TraceCaptureTag,
} from "../runtime-surface/trace-capture.js";

export type { UserId, AgentId, ConversationId };

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
   * Optional bearer-token session validator (called from `network/connect`
   * when the caller authenticates with a `sessionToken`). Unset → bearer-
   * token auth is unsupported; only `agentKey` auth works.
   */
  sessionValidator?: SessionValidator;
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
  /** Owner user ID resolved at network/connect time. Null for unclaimed agents. */
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
   * Outbound-routing primitive. Apps emit events out-of-band via
   * `networkSendService.send(to, payload)` (directed) or
   * `networkSendService.broadcast(agentIds, payload, opts?)` (fan-out
   * across participants). Stable identity across the server lifetime.
   *
   * The backing `AgentEndpointResolver` is intentionally not exposed —
   * its mutable add/remove surface is server-internal lifecycle, not a
   * CoreApp consumer concern. Tests assert resolver state indirectly
   * via `networkSendService.send` outcomes.
   */
  readonly networkSendService: NetworkSendService;
  readonly traceCapture: TraceCapture;
  /**
   * Live ConnectionManager instance. Apps can query `getByParticipant` to
   * check whether an agent has any live connections (for presence-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;
  registerApp: (manifest: AppManifest) => void;
  /**
   * Register an app whose `dispatch/authorize` admission round-trips
   * run in a remote process over WebSocket. The verb routes to
   * `connectionId` via the server-initiated awaitable RPC primitive;
   * verdicts decode at the WS edge into the same typed shapes as
   * in-process hooks. Fail-closed on disconnect / timeout / RPC error.
   *
   * Promotes any prior in-process registration for the same `appId`.
   * Use {@link unregisterRemoteApp} to drop the routing entry eagerly
   * when a connection is known to be gone (operator-driven cleanup;
   * the disconnect-finalizer handles in-flight Deferreds either way).
   */
  registerRemoteApp: (manifest: AppManifest, connectionId: string) => void;
  /**
   * Drop a remote-app registration. Idempotent. Does NOT remove the
   * manifest; only the routing entry. See {@link AppHost.unregisterRemoteApp}.
   */
  unregisterRemoteApp: (appId: string) => void;
  setContactService: (checker: ContactService) => void;
  onTaskAuthorizeDispatch: (
    appId: string,
    handler: TaskAuthorizeDispatchHook,
  ) => void;
  /**
   * #560: register an in-process `messages/authorize` handler keyed by
   * `EndpointAddress`. Default-DM and default-group register at boot
   * to preserve today's broadcast; apps register their custom TM hook
   * via this surface. Idempotent — repeat calls overwrite the entry.
   */
  registerMessageAuthorize: (
    address: EndpointAddress,
    handler: MessageAuthorizeHook,
  ) => void;
  /**
   * #529 reshape additive — server-local lease registry for the
   * `dispatch/{request, authorize, release}` admission surface.
   * Stable identity across the server lifetime. Tests + advanced
   * consumers can read lease state directly via this handle.
   */
  readonly leaseRegistry: LeaseRegistry;
  close: () => PromiseLike<void>;
}
