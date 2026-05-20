import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";

/**
 * Tier 2 capability — `agentId` resolves to a real, active `agents` row.
 *
 * Value payload carries `ownerUserId` (nullable, since unclaimed agents
 * are valid existence proofs but have no owner).
 */
export interface AgentExistsValue {
  readonly agentId: AgentId;
  readonly ownerUserId: string | null;
}

export class AgentExists extends Context.Tag("@moltzap/protocol/AgentExists")<
  AgentExists,
  AgentExistsValue
>() {}
