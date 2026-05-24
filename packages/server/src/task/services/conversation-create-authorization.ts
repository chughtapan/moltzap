import { Effect } from "effect";
import type {
  ConversationCreateAuthorizationValue,
  ObtainConversationCreateAuthorizationInput,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../../app/layers.js";
import type { ConversationServiceError } from "./conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

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
