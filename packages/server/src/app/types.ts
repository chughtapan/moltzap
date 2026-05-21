import type {
  AppManifest,
  DispatchAuthorize,
  MessagesAuthorize,
  ParamsOf,
  ResultOf,
} from "@moltzap/protocol";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ContactService } from "./app-host.js";
import type { ConnectionManager } from "../transport/connection.js";
import type { NetworkSendService } from "../network/network-send.js";
import type { EndpointAddress } from "@moltzap/protocol/network";
import type { LeaseRegistry } from "../task/leases/lease-registry.js";

export type { UserId, AgentId };

// Hook type derivations — context + result shapes come from the protocol's
// wire schemas via `ParamsOf` / `ResultOf`. The `signal: AbortSignal` reaches
// handlers via the runner that invokes them (`AppHost.runInProcessHookEffect`),
// not via the wire context.

export type TaskAuthorizeDispatchContext = ParamsOf<typeof DispatchAuthorize>;

export type DispatchAdmissionResult = ResultOf<
  typeof DispatchAuthorize
>["admission"];

export type TaskAuthorizeDispatchHook = (
  ctx: TaskAuthorizeDispatchContext & { signal: AbortSignal },
) => DispatchAdmissionResult | Promise<DispatchAdmissionResult>;

export type MessageAuthorizeContext = ParamsOf<typeof MessagesAuthorize>;

export type MessageAuthorizeResult = ResultOf<
  typeof MessagesAuthorize
>["verdict"];

export type MessageAuthorizeHook = (
  ctx: MessageAuthorizeContext & { signal: AbortSignal },
) => MessageAuthorizeResult | Promise<MessageAuthorizeResult>;

export interface CoreApp {
  readonly port: number;

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
