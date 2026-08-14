/**
 * @file In-memory mirror of NanoClaw's messaging-group store for isolated
 * adapter tests. The same module path binds to NanoClaw's SQLite-backed store
 * when the adapter is installed in the host application.
 */

import type { MessagingGroup, MessagingGroupAgent } from "../types.js";

const groups = new Map<string, MessagingGroup>();
const wirings = new Map<string, MessagingGroupAgent>();

/**
 * Records a messaging group by its persistent identifier.
 * @param group Host routing row to record.
 */
export function createMessagingGroup(group: MessagingGroup): void {
  groups.set(group.id, group);
}

/**
 * Finds the messaging group attached to one channel and platform address.
 * @param channelType Channel implementation that owns the address.
 * @param platformId Platform address assigned to the group.
 * @returns The matching group, or `undefined` when the address is unknown.
 */
export function getMessagingGroupByPlatform(
  channelType: string,
  platformId: string,
): MessagingGroup | undefined {
  for (const group of groups.values()) {
    if (
      group.channel_type === channelType &&
      group.platform_id === platformId
    ) {
      return group;
    }
  }
  return undefined;
}

/**
 * Records the routing relationship between a messaging group and an agent.
 * @param mga Host routing row to record.
 */
export function createMessagingGroupAgent(mga: MessagingGroupAgent): void {
  wirings.set(mga.id, mga);
}

/**
 * Finds the routing relationship for one messaging-group and agent-group pair.
 * @param messagingGroupId Messaging group side of the relationship.
 * @param agentGroupId Agent group side of the relationship.
 * @returns The matching wiring, or `undefined` when the pair is not connected.
 */
export function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): MessagingGroupAgent | undefined {
  for (const wiring of wirings.values()) {
    if (
      wiring.messaging_group_id === messagingGroupId &&
      wiring.agent_group_id === agentGroupId
    ) {
      return wiring;
    }
  }
  return undefined;
}
