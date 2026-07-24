// Stub matching the subset of nanoclaw's src/db/agent-groups.ts that
// moltzap.ts touches; resolves against the real sqlite-backed module inside
// a nanoclaw checkout.
import type { AgentGroup } from "../types.js";

const agentGroups = new Map<string, AgentGroup>();

export function getAllAgentGroups(): AgentGroup[] {
  return [...agentGroups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createAgentGroup(group: AgentGroup): void {
  agentGroups.set(group.id, group);
}

/**
 * Test hook; resets state the real nanoclaw module persists in sqlite.
 * @internal
 */
export function clearAgentGroups(): void {
  agentGroups.clear();
}
