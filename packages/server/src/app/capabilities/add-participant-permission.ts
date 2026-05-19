import { Context, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import { ConversationServiceTag, ParticipantServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

/**
 * Single-arm composite capability for `ConversationService.addParticipant`
 * — Architect plan #606 r3 Decision D.
 *
 * Today's `addParticipantEffect` runs four sequential gates with no
 * short-circuit:
 *
 *     assertAddParticipantAuthority(input)
 *     targetOwnerUserId = participants.assertAgentExists(input.agentId)
 *     assertAddParticipantContactPolicy(requester, target, ownerId)
 *     assertParticipantCapacity(conversationId)
 *
 * Three sibling R-channel tags would work, but the handler would emit
 * three `provideServiceEffect` blocks. A single-arm composite reduces
 * that to one obtain at the handler tier AND carries the resolved
 * `targetOwnerUserId` so the service body skips the downstream
 * re-fetch (payload reuse parallel to `MessageSendPermission` carrying
 * `task` + `replyTarget`).
 *
 * No discriminated-union arms: there is no dedup short-circuit and no
 * TM-bypass branching. TM bypass for addParticipant lives inside
 * `assertAddParticipantAuthority` via the existing
 * `assertConversationAdminAuthority` helper; the resulting authority
 * proof shape is the same either way, so the composite stays flat.
 */
export interface AddParticipantPermissionValue {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly targetAgentId: AgentId;
  readonly targetOwnerUserId: string | null;
}

export class AddParticipantPermission extends Context.Tag(
  "@moltzap/server/AddParticipantPermission",
)<AddParticipantPermission, AddParticipantPermissionValue>() {}

export interface ObtainAddParticipantPermissionInput {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly targetAgentId: AgentId;
}

/**
 * Smart constructor. Runs the four gates in their pre-Spec-E order;
 * carries the resolved `targetOwnerUserId` so the service body and
 * any downstream auditing can read it without an extra round-trip.
 */
export const obtainAddParticipantPermission = (
  input: ObtainAddParticipantPermissionInput,
): Effect.Effect<
  AddParticipantPermissionValue,
  ConversationServiceError,
  ConversationServiceTag | ParticipantServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const participants = yield* ParticipantServiceTag;
      yield* conversations.assertAddParticipantAuthority({
        conversationId: input.conversationId,
        agentId: input.targetAgentId,
        requesterAgentId: input.requesterAgentId,
      });
      const targetOwnerUserId = yield* participants.assertAgentExists(
        input.targetAgentId,
      );
      yield* conversations.assertAddParticipantContactPolicy(
        input.requesterAgentId,
        input.targetAgentId,
        targetOwnerUserId,
      );
      yield* conversations.assertParticipantCapacity(input.conversationId);
      return {
        conversationId: input.conversationId,
        requesterAgentId: input.requesterAgentId,
        targetAgentId: input.targetAgentId,
        targetOwnerUserId,
      };
    }),
  ).pipe(Effect.withSpan("obtainAddParticipantPermission"));
