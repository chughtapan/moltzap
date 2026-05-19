import { Effect } from "effect";
import type { NotFoundError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { AgentExists, type AgentExistsValue } from "@moltzap/protocol/task";
import { ParticipantServiceTag } from "../layers.js";

export { AgentExists, type AgentExistsValue };

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
