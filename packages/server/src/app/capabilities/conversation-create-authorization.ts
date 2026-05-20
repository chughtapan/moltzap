import { Effect } from "effect";
import {
  ConversationCreateAuthorization,
  type ConversationCreateAuthorizationValue,
  type ObtainConversationCreateAuthorizationInput,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

export {
  ConversationCreateAuthorization,
  type ConversationCreateAuthorizationValue,
  type ObtainConversationCreateAuthorizationInput,
};

/**
 * Smart constructor for `ConversationsCreate`. Reaches into
 * `ConversationService` via the service Tag to:
 *  1. Load `ownerByAgentId` via `loadAgentOwners` (NotFound if any
 *     agent missing).
 *  2. Check for an existing DM via `existingDmForCreate` (DM-arity
 *     invariants enforced inside the helper). Returns `ExistingDm`
 *     when found; this is the short-circuit branch.
 *  3. Otherwise: run the contact-policy and group-capacity gates and
 *     return `PermittedToCreate { ownerByAgentId }`.
 * @failure NotFoundError when a referenced `agents` row is missing
 * @failure InvalidParamsError when DM-arity invariants are violated
 * @failure NotInContactsError when caller's contact policy rejects a target
 * @failure ForbiddenError when policy denies the create
 * @failure ConversationFullError when participant count exceeds the policy limit
 */
export const obtainConversationCreateAuthorization = (
  input: ObtainConversationCreateAuthorizationInput,
): Effect.Effect<
  ConversationCreateAuthorizationValue,
  ConversationServiceError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.loadAgentOwners(
        input.agentIds,
      );
      const existingDm = yield* conversations.existingDmForCreate({
        type: input.type,
        agentIds: input.agentIds,
        creatorAgentId: input.creatorAgentId,
      });
      if (existingDm !== null) {
        return { _tag: "ExistingDm" as const, conversation: existingDm };
      }
      yield* conversations.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.agentIds,
        input.type,
        ownerByAgentId,
      );
      yield* conversations.assertGroupCapacityForCreate(
        input.type,
        input.agentIds,
      );
      return { _tag: "PermittedToCreate" as const, ownerByAgentId };
    }),
  ).pipe(Effect.withSpan("obtainConversationCreateAuthorization"));
