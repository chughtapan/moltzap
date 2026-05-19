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
 * Designed to replace the per-agent existence check inside
 * `ConversationService.loadAgentOwners`. `ConversationService.create`
 * still calls `loadAgentOwners` inline today; the obtain helper is
 * available for D1-style new handlers and for the eventual cutover
 * once `conversation.service.ts` is restructured to fit the
 * `max-lines: 1050` lint cap with the added R-channel plumbing.
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
