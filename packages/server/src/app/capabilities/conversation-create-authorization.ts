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
      yield* conversations.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.agentIds,
        ownerByAgentId,
      );
      yield* conversations.assertGroupCapacityForCreate(input.agentIds);
      return { ownerByAgentId };
    }),
  ).pipe(Effect.withSpan("obtainConversationCreateAuthorization"));
