import { Effect } from "effect";
import type { NotificationParamsOf } from "@moltzap/protocol/rpc";
import type { AgentId } from "@moltzap/protocol/identity";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type { NetworkSendService } from "./network-send.js";
import { NetworkSendServiceTag } from "./layer.js";

type BroadcastOptions = NonNullable<
  Parameters<NetworkSendService["broadcastNotification"]>[3]
>;

/**
 * Fan a server→client notification out to every live connection of each agent
 * in `agentIds`. The notification rides the reverse `RpcClient` on each target
 * connection (fired fork-and-forget, the `void` result settles on the client's
 * ack); the client's reverse `RpcServer` routes it into its
 * `SubscriberRegistry`. Replaces the raw `socket.write(encodedFrame)` path.
 * @param agentIds Value supplied to the operation.
 * @param definition Protocol definition to process.
 * @param params Request payload to process.
 * @param options Options that control the operation.
 * @returns The broadcast notification to agents result.
 */
export const broadcastNotificationToAgents = <
  D extends AnyNotificationDefinition,
>(
  agentIds: readonly AgentId[],
  definition: D,
  params: NotificationParamsOf<D>,
  options?: BroadcastOptions,
): Effect.Effect<void, never, NetworkSendServiceTag> =>
  Effect.gen(function* () {
    if (agentIds.length === 0) {
      return;
    }
    const networkSendService = yield* NetworkSendServiceTag;
    yield* networkSendService.broadcastNotification(
      agentIds,
      definition,
      params,
      options,
    );
  }).pipe(Effect.withSpan("notifications.broadcastToAgents"));
