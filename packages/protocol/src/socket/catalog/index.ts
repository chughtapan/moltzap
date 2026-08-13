/**
 * @file Closed RPC catalogs and Effect RPC groups for first-party socket wiring.
 *
 * The main socket barrel exposes lifecycle classes. This module exposes the
 * derived method/notification catalogs and group types needed by client and
 * server-core.
 */
import { type Rpc, RpcGroup } from "@effect/rpc";
import { agentConversationCreate } from "#conversation";
import { agentsList } from "#identity";
import { messageReceivedNotificationDefinition, messagesSend } from "#message";
import { agentConnect } from "#network";

/**
 * Client-to-server descriptors an agent principal may originate.
 */
const agentCallableMethods = [
  agentsList,
  agentConnect,
  agentConversationCreate,
  messagesSend,
] as const;

/**
 * Every server-to-client notification descriptor.
 */
const notificationDefinitions = [
  messageReceivedNotificationDefinition,
] as const;

/** Any client-to-server descriptor the server handles. */
type AnyServerRpcDefinition = (typeof agentCallableMethods)[number];

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
  agentCallableMethods.map((definition) => definition.serverRpc),
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
 * The full server-to-client reverse group: every notification descriptor,
 * built as ONE `RpcGroup` over the member tuple. The server holds one
 * `RpcClient&lt;ReverseRpcGroup>` per connection (fires notifications
 * fork-and-forget); clients stand one `RpcServer&lt;ReverseRpcGroup>` on the
 * s2c sink, routing each payload into the `SubscriberRegistry`.
 */
export const reverseRpcGroup = makeRpcGroup(
  notificationDefinitions.map((definition) => definition.notificationRpc),
);
