import { RpcGroup, type Rpc } from "@effect/rpc";
import {
  identityRpcMethods,
  identityNotifications,
} from "./identity/methods.js";
import {
  agentCallableNetworkRpcMethods,
  appCallableNetworkRpcMethods,
  networkRpcMethods,
  networkNotifications,
} from "./network/index.js";
import {
  taskNotifications,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
} from "./task/methods.js";
import {
  agentCallableMessageRpcMethods,
  messageNotifications,
} from "./message/index.js";
import {
  agentCallableDispatchRpcMethods,
  appCallableDispatchRpcMethods,
  dispatchNotifications,
} from "./dispatch/index.js";
import { appCallbackMethods as appDomainCallbackMethods } from "./app/methods.js";

export const appCallbackMethods = appDomainCallbackMethods;

const appOnlyCallableMethods = [
  ...appCallableTaskRpcMethods,
  ...appCallableDispatchRpcMethods,
] as const;

// The three authored RPC catalogs:
//   `agentCallableMethods` - client→server methods an agent may originate.
//   `appCallableMethods`   - client→server methods an app may originate.
//   `appCallbackMethods`   - server→app result-bearing callbacks.
//
// `serverInboundMethods` is not an authored fourth catalog; it is the c2s
// execution union of AgentCallable ∪ AppCallable, with the unauthenticated
// `agent/connect` and `app/connect` descriptors included once.
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...agentCallableDispatchRpcMethods,
] as const;

export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const;

export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...appOnlyCallableMethods,
  ...agentCallableDispatchRpcMethods,
] as const;

export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...messageNotifications,
  ...dispatchNotifications,
] as const;

export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];

export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];

export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

type ClientRpcDescriptor = { readonly clientRpc: Rpc.Any };

const makeClientRpcGroup = <const Defs extends readonly ClientRpcDescriptor[]>(
  defs: Defs,
): RpcGroup.RpcGroup<Defs[number]["clientRpc"]> =>
  RpcGroup.make(...defs.map((definition) => definition.clientRpc));

export const AgentCallableGroup = makeClientRpcGroup(agentCallableMethods);

export const AppCallableGroup = makeClientRpcGroup(appCallableMethods);

type NotificationRpcDescriptor = { readonly notificationRpc: Rpc.Any };

const makeNotificationRpcGroup = <
  const Defs extends readonly NotificationRpcDescriptor[],
>(
  defs: Defs,
): RpcGroup.RpcGroup<Defs[number]["notificationRpc"]> =>
  RpcGroup.make(...defs.map((definition) => definition.notificationRpc));

const makeReverseRpcGroup = <
  const Callbacks extends readonly ClientRpcDescriptor[],
  const Notifications extends readonly NotificationRpcDescriptor[],
>(
  callbacks: Callbacks,
  notifications: Notifications,
): RpcGroup.RpcGroup<
  Callbacks[number]["clientRpc"] | Notifications[number]["notificationRpc"]
> =>
  RpcGroup.make(
    ...callbacks.map((definition) => definition.clientRpc),
    ...notifications.map((definition) => definition.notificationRpc),
  );

/**
 * Build the server→client reverse `RpcGroup` for the notification catalog. Each
 * `defineNotification` descriptor maps to a `void`-result `Rpc.make`: the
 * notification's params is the payload, the success is `Schema.Void`. The
 * server holds the `RpcClient&lt;NotificationRpcGroup>` (fires each notification on
 * a target connection's reverse channel, fork-and-forget); the agent + app
 * clients hold the `RpcServer&lt;NotificationRpcGroup>` whose handlers route each
 * payload into the `SubscriberRegistry`, preserving the
 * `client.subscribe(def) → Stream` surface unchanged.
 */

/**
 * Server→client reverse notification group. The server fires each notification
 * as a fire-and-forget `void`-result RPC on a target connection's reverse
 * channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
 * each payload into the `SubscriberRegistry`. Reuses the same s2c reverse-RPC
 * machinery as the moderator callbacks folded into {@link ReverseRpcGroup}.
 */
export const NotificationRpcGroup = makeNotificationRpcGroup(
  notificationDefinitions,
);

/**
 * The full server→client reverse group: the moderator callbacks
 * (`appCallbackMethods`) ∪ the notifications ({@link NotificationRpcGroup}),
 * built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
 * server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
 * awaiting a verdict, fires notifications fork-and-forget); the agent + app
 * clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
 * only ever receives notifications (its handlers for the three callback methods
 * are never invoked — an agent is not a moderator), but it serves the whole
 * group so the s2c engine binds one handler map.
 */
export const ReverseRpcGroup = makeReverseRpcGroup(
  appCallbackMethods,
  notificationDefinitions,
);
