import type { Kysely } from "kysely";
import { Effect } from "effect";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import type { Database } from "../db/database.js";

/**
 * Result of resolving the app session governing a conversation, by joining
 * `conversations.task_id → tasks.app_id`. Discriminates the four cases the
 * caller in {@link AppHost.runAuthorizeDispatch} must distinguish:
 *
 * - `NoAppSession` — parent task has `app_id IS NULL` and the conversation
 *   is not archived. Caller default-grants (no moderator to consult).
 * - `AppBound` — parent task has `app_id IS NOT NULL`. Caller routes to
 *   the in-process hook (`AppHost.hooks` map) or remote registration
 *   (`AppHost.remoteRegistrations` map) for that `appId`.
 * - `ConversationArchived` — `conversations.archived_at IS NOT NULL`.
 *   Caller denies with reason `"conversation_archived"`. This branch
 *   preserves the current behavior at `app-host.ts:185-201@dfb0d69`,
 *   which is reachable today via the dead-Map default path.
 * - `ConversationNotFound` — no row matches the given `conversationId`.
 *   Caller default-grants (preserves the current
 *   `app-host.ts:200@dfb0d69` fall-through).
 *
 * The discriminated union — rather than `Option<{...}>` plus a separate
 * archived flag — encodes exhaustiveness at the type level: every caller
 * `switch` ends in `absurd(_)` and a future fifth case becomes a compile
 * error at every call site (Principle 4).
 */
export type ConversationAppLookup =
  | { readonly _tag: "NoAppSession" }
  | {
      readonly _tag: "AppBound";
      readonly taskId: TaskId;
      readonly appId: string;
    }
  | { readonly _tag: "ConversationArchived" }
  | { readonly _tag: "ConversationNotFound" };

/**
 * Resolve which app (if any) governs the conversation by joining
 * `conversations.task_id → tasks.app_id`. Replaces the dead in-memory
 * `conversationToSession` cache at `app-host.ts:74-78@dfb0d69`.
 *
 * Implementation contract for the downstream `implement-senior` PR:
 * - SQL: `SELECT conversations.archived_at, tasks.id AS task_id,
 *   tasks.app_id FROM conversations INNER JOIN tasks ON tasks.id =
 *   conversations.task_id WHERE conversations.id = ?` (Kysely query
 *   builder; never raw SQL per project memory).
 * - `INNER JOIN` is correct because `conversations.task_id` is `NOT NULL`
 *   with a FK to `tasks.id` (per `database.generated.ts:80@dfb0d69` plus
 *   the round-3 R12 schema invariant referenced at
 *   `conversation.service.ts:132@dfb0d69`).
 * - On zero rows → `ConversationNotFound`.
 * - On one row with `archived_at IS NOT NULL` → `ConversationArchived`
 *   (regardless of `app_id`; the archive check fires before the app
 *   discriminator, matching today's ordering).
 * - On one row with `archived_at IS NULL` and `app_id IS NULL` →
 *   `NoAppSession`.
 * - On one row with `archived_at IS NULL` and `app_id IS NOT NULL` →
 *   `AppBound { taskId, appId }`.
 *
 * Error channel is `never`: SQL errors surface as defects via
 * `catchSqlErrorAsDefect` at the call site in `app-host.ts:183@dfb0d69`,
 * which is the existing convention for AppHost DB reads. Defects are
 * the right channel here — a database failure during admission is a
 * server-internal fault, not a moderator verdict.
 */
export function lookupAppForConversation(
  db: Kysely<Database>,
  conversationId: ConversationId,
): Effect.Effect<ConversationAppLookup, never, never> {
  // Architect-stage stub per safer:architect Iron rule. Effect.dieMessage
  // is the typed-channel equivalent of `throw new Error("not implemented")`
  // for an Effect-returning function: same "must not run" semantic, no raw
  // throw to wedge the lint rule, and the parameters land in the
  // signature/types where the implementer fills the body in.
  void db;
  void conversationId;
  return Effect.dieMessage("not implemented: lookupAppForConversation");
}
