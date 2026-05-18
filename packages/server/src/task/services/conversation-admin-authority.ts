import type { Kysely } from "kysely";
import { Effect, Option } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import { ForbiddenError } from "@moltzap/protocol";
import type { Database } from "../../db/database.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";
import { endpointAddressForAgent } from "./task.service.js";

/**
 * Authority gate for conversation-level admin operations
 * (`update`, `archive`, `unarchive`, `addParticipant`, `removeParticipant`).
 * Replaces `ConversationService.requireRole(conv, agent, ["owner","admin"])`
 * — the redundant role-column gate that has exactly one writer site
 * (`conversationService.create` at insert time) and no promote-to-admin
 * flow, so `["owner","admin"]` collapses to "the original creator" for
 * non-app-bound rows.
 *
 * Discriminator: `task.app_id IS NULL`.
 *
 * - **`app_id IS NULL`** (default DM / group; no app session): the
 *   conversation creator is the authority. Pass iff
 *   `callerAgentId === conversations.created_by_id`.
 * - **`app_id IS NOT NULL`** (app-bound; moderator IS TM): the parent
 *   task's TM is the authority. Pass iff
 *   `endpointAddressForAgent(callerAgentId) === task.tm_endpoint_address`.
 *
 * Error channel: `ForbiddenError` only.
 *
 * - Conversation row missing → `ForbiddenError` (NOT `NotFoundError`).
 *   Matches the pre-helper `requireRole` shape, so the wire-level error
 *   code observed by clients is unchanged when admin operations target
 *   a non-existent conversation.
 * - Caller fails the discriminator → `ForbiddenError` with message
 *   `"Insufficient permissions"` (preserves the pre-helper wording).
 *
 * SQL execution failures surface as defects via `catchSqlErrorAsDefect`
 * — the existing convention for service-layer DB reads in this package,
 * mirrored from `requireRole` and `requireParticipant`.
 */
export function requireConversationAdminAuthority(
  db: Kysely<Database>,
  conversationId: ConversationId,
  callerAgentId: AgentId,
): Effect.Effect<void, ForbiddenError, never> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("conversations")
          .innerJoin("tasks", "tasks.id", "conversations.task_id")
          .select([
            "conversations.created_by_id",
            "tasks.app_id",
            "tasks.tm_endpoint_address",
          ])
          .where("conversations.id", "=", conversationId)
          .limit(1),
      );
      if (Option.isNone(rowOpt)) {
        return yield* Effect.fail(
          new ForbiddenError({ message: "Insufficient permissions" }),
        );
      }
      const row = rowOpt.value;
      const isAuthorized =
        row.app_id === null
          ? row.created_by_id === callerAgentId
          : row.tm_endpoint_address === endpointAddressForAgent(callerAgentId);
      if (!isAuthorized) {
        return yield* Effect.fail(
          new ForbiddenError({ message: "Insufficient permissions" }),
        );
      }
    }).pipe(Effect.withSpan("requireConversationAdminAuthority")),
  );
}
