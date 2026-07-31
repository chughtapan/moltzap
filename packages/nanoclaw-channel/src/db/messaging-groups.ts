// Stub matching the subset of nanoclaw's src/db/messaging-groups.ts that
// moltzap.ts touches; resolves against the real sqlite-backed module inside
// a nanoclaw checkout. The in-repo store is an in-memory map so unit tests
// can observe eval-mode wiring creation.
import type { MessagingGroup, MessagingGroupAgent } from "../types.js";

export function createMessagingGroup(group: MessagingGroup): void {
  groups.set(group.id, group);
}

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

export function createMessagingGroupAgent(mga: MessagingGroupAgent): void {
  wirings.set(mga.id, mga);
}

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

const groups = new Map<string, MessagingGroup>();
const wirings = new Map<string, MessagingGroupAgent>();
