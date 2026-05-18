import { Context, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { ParticipantServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Tier 2 capability — `agentId` resolves to a real, active `agents` row.
 *
 * Value payload carries `ownerUserId` (nullable, since unclaimed agents
 * are valid existence proofs but have no owner).
 *
 * Replaces (Phase 3): the per-agent existence checks inside
 * `ConversationService.requireAgentsExist` (which becomes an `@internal`
 * fan-out helper that the composite `ContactPolicyAllowsReach` obtain
 * still uses).
 */
export interface AgentExistsValue {
  readonly agentId: AgentId;
  readonly ownerUserId: string | null;
}

export class AgentExists extends Context.Tag("@moltzap/server/AgentExists")<
  AgentExists,
  AgentExistsValue
>() {}

/**
 * Architect-stub. Body shape:
 *   const participants = yield* ParticipantServiceTag;
 *   const ownerUserId = yield* participants.requireExists(agentId);
 *   return { agentId, ownerUserId };
 */
export const obtainAgentExists = (
  _agentId: AgentId,
): Effect.Effect<AgentExistsValue, never, ParticipantServiceTag> =>
  notImplemented("obtainAgentExists") as never;
