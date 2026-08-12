/**
 * @file Closed RPC catalogs and Effect RPC groups for first-party socket wiring.
 *
 * The main socket barrel exposes lifecycle classes. This module exposes the
 * derived method/notification catalogs and group types needed by client and
 * server-core.
 */
import { type Rpc, RpcGroup } from "@effect/rpc";
import {
  agentCallableConversationRpcMethods,
  conversationNotifications,
} from "#conversation";
import { identityRpcMethods } from "#identity";
import { agentCallableMessageRpcMethods, messageNotifications } from "#message";
import {
  agentCallableNetworkRpcMethods,
  networkNotifications,
  networkRpcMethods,
} from "#network";

/**
 * Client-to-server descriptors an agent principal may originate.
 */
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
] as const;

/**
 * Full server inbound descriptor union.
 *
 * This is derived from the authored agent callable catalog, with the
 * unauthenticated connect descriptor included once.
 */
export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableConversationRpcMethods,
  ...agentCallableMessageRpcMethods,
] as const;

/**
 * Every server-to-client notification descriptor.
 */
export const notificationDefinitions = [
  ...networkNotifications,
  ...conversationNotifications,
  ...messageNotifications,
] as const;

/** Any client-to-server descriptor the server handles. */
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];

/** Any descriptor an agent client may call. */
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];

/** Any server-to-client notification descriptor. */
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

const makeRpcGroup = <const R extends Rpc.Any>(
  rpcs: readonly R[],
): RpcGroup.RpcGroup<R> => RpcGroup.make(...rpcs);

/**
 * Effect RPC group for all client-to-server calls accepted by the server.
 */
export const serverInboundGroup = makeRpcGroup(
  serverInboundMethods.map((definition) => definition.serverRpc),
);

/**
 * Complete server handler table keyed by every inbound RPC tag.
 */
export type ServerHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof serverInboundGroup>
>;

/** Handler type for one inbound RPC descriptor. */
export type ServerHandler<D extends AnyServerRpcDefinition> =
  ServerHandlers[Extract<D["name"], keyof ServerHandlers>];

/** Effect RPC group for all agent-callable methods. */
export const agentCallableGroup = makeRpcGroup(
  agentCallableMethods.map((definition) => definition.clientRpc),
);

/**
 * Server-to-client reverse notification group. The server fires each notification
 * as a fire-and-forget `void`-result RPC on a target connection's reverse
 * channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
 * each payload into the `SubscriberRegistry`.
 */
export const notificationRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
);

/**
 * The full server-to-client reverse group: every notification descriptor,
 * built as ONE `RpcGroup` over the member tuple. The server holds one
 * `RpcClient&lt;ReverseRpcGroup>` per connection (fires notifications
 * fork-and-forget); clients stand one `RpcServer&lt;ReverseRpcGroup>` on the
 * s2c sink, routing each payload into the `SubscriberRegistry`.
 */
export const reverseRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
);
