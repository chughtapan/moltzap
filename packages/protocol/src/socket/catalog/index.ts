/**
 * @file Closed RPC catalogs and Effect RPC groups for first-party socket wiring.
 *
 * The main socket barrel exposes lifecycle classes. This module exposes the
 * derived method/notification catalogs and group types needed by client,
 * server-core, conformance, and generated protocol reference docs.
 */
import { RpcGroup, type Rpc } from "@effect/rpc";
import { identityRpcMethods, identityNotifications } from "#identity";
import {
  agentCallableNetworkRpcMethods,
  appCallableNetworkRpcMethods,
  networkRpcMethods,
  networkNotifications,
} from "#network";
import {
  taskNotifications,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
  taskCallbackMethods,
} from "#task";
import {
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "#conversation";
import {
  agentCallableMessageRpcMethods,
  messageCallbackMethods,
  messageNotifications,
} from "#message";
import {
  agentCallableDispatchRpcMethods,
  appCallableDispatchRpcMethods,
  dispatchCallbackMethods,
  dispatchNotifications,
} from "#message/dispatch";

/**
 * Server-to-app callback descriptors the app client must serve.
 */
export const appCallbackMethods = [
  ...dispatchCallbackMethods,
  ...messageCallbackMethods,
  ...taskCallbackMethods,
] as const;

const appOnlyCallableMethods = [
  ...appCallableTaskRpcMethods,
  ...appCallableConversationRpcMethods,
  ...appCallableDispatchRpcMethods,
] as const;

/**
 * Client-to-server descriptors an agent principal may originate.
 */
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...agentCallableDispatchRpcMethods,
] as const;

/**
 * Client-to-server descriptors an app principal may originate.
 */
export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const;

/**
 * Full server inbound descriptor union.
 *
 * This is derived from the authored agent and app callable catalogs, with the
 * unauthenticated connect descriptors included once.
 */
export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
  ...appOnlyCallableMethods,
  ...agentCallableDispatchRpcMethods,
] as const;

/**
 * Every server-to-client notification descriptor.
 */
export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...conversationNotifications,
  ...messageNotifications,
  ...dispatchNotifications,
] as const;

/** Any client-to-server descriptor the server handles. */
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];

/** Any descriptor an agent client may call. */
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];

/** Any descriptor an app client may call. */
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];

/** Any callback descriptor the server may call on an app client. */
export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];

/** Any server-to-client notification descriptor. */
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

const makeRpcGroup = <const R extends Rpc.Any>(
  rpcs: readonly R[],
): RpcGroup.RpcGroup<R> => RpcGroup.make(...rpcs);

/**
 * Effect RPC group for all client-to-server calls accepted by the server.
 */
export const ServerInboundGroup = makeRpcGroup(
  serverInboundMethods.map((definition) => definition.serverRpc),
);

/**
 * Complete server handler table keyed by every inbound RPC tag.
 */
export type ServerHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof ServerInboundGroup>
>;

/** Handler type for one inbound RPC descriptor. */
export type ServerHandler<D extends AnyServerRpcDefinition> =
  ServerHandlers[Extract<D["name"], keyof ServerHandlers>];

/** Effect RPC group for all agent-callable methods. */
export const AgentCallableGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.clientRpc),
);

/** Effect RPC group for all app-callable methods. */
export const AppCallableGroup = makeRpcGroup(
  appCallableMethods.map((definition) => definition.clientRpc),
);

/**
 * Server-to-client reverse notification group. The server fires each notification
 * as a fire-and-forget `void`-result RPC on a target connection's reverse
 * channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
 * each payload into the `SubscriberRegistry`.
 */
export const NotificationRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
);

/**
 * The full server-to-client reverse group: the moderator callbacks
 * (`appCallbackMethods`) plus the notifications ({@link NotificationRpcGroup}),
 * built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
 * server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
 * awaiting a verdict, fires notifications fork-and-forget); the agent + app
 * clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
 * only ever receives notifications (its handlers for the three callback methods
 * are never invoked; an agent is not a moderator), but it serves the whole
 * group so the s2c engine binds one handler map.
 */
export const ReverseRpcGroup = makeRpcGroup([
  ...appCallbackMethods.map((definition) => definition.clientRpc),
  ...notificationDefinitions.map((definition) => definition.notificationRpc),
]);

// safer-arch-ignore require-boundary-owned-types: The public socket catalog is the composition facade for protocol-owned identity, network, task, conversation, and message descriptor groups. Tracked upstream: chughtapan/safer-architecture-lsp#2.
