import type { Kysely } from "kysely";
import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import type { ForbiddenError } from "@moltzap/protocol";
import type { Database } from "../db/database.js";

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
 * The `app_id` discriminator (rather than endpoint-address pattern
 * matching) is chosen because `app_id` is the canonical "is this
 * app-bound?" signal already in the schema. Pure TM-of-parent-task
 * would brick admin operations for ordinary creators of default DMs
 * and groups whose `tm_endpoint_address` is one of the literal
 * default-TM UUIDs (`tm:app:<defaultDmTm | defaultGroupTm>` from
 * `network/app-tm-registry.ts`), not any caller's
 * `tm:agent:<callerAgentId>`.
 *
 * SQL shape (single round-trip, mirrors `lookupAppForConversation` at
 * `packages/server/src/app/conversation-app-lookup.ts`):
 *
 * ```
 * SELECT conversations.created_by_id,
 *        tasks.app_id,
 *        tasks.tm_endpoint_address
 * FROM   conversations
 * INNER JOIN tasks ON tasks.id = conversations.task_id
 * WHERE  conversations.id = ?
 * LIMIT  1
 * ```
 *
 * `INNER JOIN` is correct: `conversations.task_id` is `NOT NULL` with
 * an FK to `tasks.id` (post Phase 9b R12), so every conversation joins
 * exactly one task row.
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
 * at the call site — the existing convention for service-layer DB
 * reads in this package, mirrored from `requireRole` and
 * `requireParticipant`.
 *
 * Implementation lives downstream (`implement-senior` for prereq 2).
 * The body is `Effect.dieMessage("not implemented")` per the
 * `/safer:architect` Iron rule — the function signature IS the
 * interface and any sketch becomes a ghost implementation downstream
 * copies instead of thinks.
 */
export function requireConversationAdminAuthority(
  db: Kysely<Database>,
  conversationId: ConversationId,
  callerAgentId: AgentId,
): Effect.Effect<void, ForbiddenError, never> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _stub = { db, conversationId, callerAgentId };
  return Effect.dieMessage("not implemented");
}
