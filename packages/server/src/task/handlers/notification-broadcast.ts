import { Effect } from "effect";
import {
  type NotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import {
  opaquePayload,
  type NetworkSendService,
} from "../../network/network-send.js";
import {
  ConversationServiceTag,
  NetworkSendServiceTag,
} from "../../app/layers.js";

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

export const broadcastNotificationToConversation = <
  D extends NotificationDefinition<string, any>,
>(
  conversationId: ConversationId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, ConversationServiceTag | NetworkSendServiceTag> =>
  Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const participants = yield* conversationService
      .getParticipantAgentIds(conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    yield* broadcastNotificationToAgents(participants, definition, params, {
      forConversation: conversationId,
    });
  }).pipe(Effect.withSpan("notifications.broadcastToConversation"));
