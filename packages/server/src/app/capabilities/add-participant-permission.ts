import { Effect } from "effect";
import {
  AddParticipantPermission,
  type AddParticipantPermissionValue,
  type ObtainAddParticipantPermissionInput,
} from "@moltzap/protocol/task";
import { ConversationServiceTag, ParticipantServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

export {
  AddParticipantPermission,
  type AddParticipantPermissionValue,
  type ObtainAddParticipantPermissionInput,
};

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
