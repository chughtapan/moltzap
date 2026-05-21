import { Effect } from "effect";
import {
  type NotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  opaquePayload,
  type NetworkSendService,
} from "../../network/network-send.js";
import { NetworkSendServiceTag } from "../../app/layers.js";

type BroadcastOptions = NonNullable<
  Parameters<NetworkSendService["broadcast"]>[2]
>;

export const broadcastNotificationToAgents = <
  D extends NotificationDefinition<string, any>,
>(
  agentIds: readonly AgentId[],
  definition: D,
  params: NotificationParamsOf<D>,
  options?: BroadcastOptions,
): Effect.Effect<void, never, NetworkSendServiceTag> =>
  Effect.gen(function* () {
    if (agentIds.length === 0) return;
    const networkSendService = yield* NetworkSendServiceTag;
    const frame = definition.encode(params);
    const payload = opaquePayload(JSON.stringify(frame));
    yield* networkSendService.broadcast(agentIds, payload, options);
  }).pipe(Effect.withSpan("notifications.broadcastToAgents"));
