import { Context, Effect } from "effect";
import type { NotFoundError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { ParticipantServiceTag } from "../layers.js";

/**
 * Tier 2 capability — `agentId` resolves to a real, active `agents` row.
 *
 * Value payload carries `ownerUserId` (nullable, since unclaimed agents
 * are valid existence proofs but have no owner).
 *
 * Replaces (Phase 3): the per-agent existence checks inside
 * `ConversationService.loadAgentOwners` (which becomes an `@internal`
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
 * Smart constructor. Delegates to `ParticipantService.assertAgentExists`
 * (already public on the service class pre-Spec-E).
 *
 * Error channel — `ParticipantService.assertAgentExists` fails with
 * `NotFoundError` when the `agents` row is absent. `SqlError` from the
 * underlying select is caught defectively inside the service helper.
 */
export const obtainAgentExists = (
  agentId: AgentId,
): Effect.Effect<AgentExistsValue, NotFoundError, ParticipantServiceTag> =>
  Effect.gen(function* () {
    const participants = yield* ParticipantServiceTag;
    const ownerUserId = yield* participants.assertAgentExists(agentId);
    return { agentId, ownerUserId };
  }).pipe(Effect.withSpan("obtainAgentExists"));
