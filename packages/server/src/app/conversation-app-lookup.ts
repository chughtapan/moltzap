import type { Kysely } from "kysely";
import { Effect, Option } from "effect";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import type { Database } from "../db/database.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";

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
 *   Caller denies with reason `"conversation_archived"`. The archive
 *   check fires before the app discriminator so an archived app-bound
 *   conversation still denies (matches the pre-helper ordering).
 * - `ConversationNotFound` — no row matches the given `conversationId`.
 *   Caller default-grants (preserves the pre-helper fall-through).
 *
 * The discriminated union — rather than `Option<{...}>` plus a separate
 * archived flag — encodes exhaustiveness at the type level: every caller
 * `switch` ends with a `never` assignment and a future fifth case
 * becomes a compile error at every call site (Principle 4).
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
 * `conversationToSession` cache that lived on `AppHost`.
 *
 * SQL shape (single round-trip):
 *
 * ```
 * SELECT conversations.archived_at,
 *        tasks.id     AS task_id,
 *        tasks.app_id AS app_id
 * FROM   conversations
 * INNER JOIN tasks ON tasks.id = conversations.task_id
 * WHERE  conversations.id = ?
 * LIMIT  1
 * ```
 *
 * `INNER JOIN` is correct: `conversations.task_id` is `NOT NULL` with a
 * FK to `tasks.id`, so every conversation row joins exactly one task
 * row. The query collapses the pre-helper archive-check + cache lookup
 * into one round-trip.
 *
 * Branch ordering matches the pre-helper behavior at the caller:
 * archive check fires first, then the app discriminator. An archived
 * app-bound conversation returns `ConversationArchived`, not `AppBound`
 * — same as the inline archive query short-circuited before the cache
 * lookup ever ran.
 *
 * Error channel is `never`: SQL errors surface as defects via
 * `catchSqlErrorAsDefect` at the call site in `AppHost.runAuthorizeDispatch`,
 * which is the existing convention for AppHost DB reads. Defects are
 * the right channel here — a database failure during admission is a
 * server-internal fault, not a moderator verdict.
 */
export function lookupAppForConversation(
  db: Kysely<Database>,
  conversationId: ConversationId,
): Effect.Effect<ConversationAppLookup, never, never> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("conversations")
          .innerJoin("tasks", "tasks.id", "conversations.task_id")
          .select([
            "conversations.archived_at",
            "tasks.id as task_id",
            "tasks.app_id",
          ])
          .where("conversations.id", "=", conversationId)
          .limit(1),
      );
      if (Option.isNone(rowOpt)) {
        return { _tag: "ConversationNotFound" } as const;
      }
      const row = rowOpt.value;
      if (row.archived_at !== null) {
        return { _tag: "ConversationArchived" } as const;
      }
      if (row.app_id === null) {
        return { _tag: "NoAppSession" } as const;
      }
      return {
        _tag: "AppBound",
        taskId: row.task_id,
        appId: row.app_id,
      } as const;
    }),
  );
}
