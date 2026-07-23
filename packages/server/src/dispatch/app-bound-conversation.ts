import { Effect, Option } from "effect";
import type { AppId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import type { Db } from "#db";
import { catchSqlErrorAsDefect, takeFirstOption } from "#db";

export interface AppBoundConversationLookup {
  readonly _tag: "AppBound";
  readonly taskId: TaskId;
  readonly appId: AppId;
}

/**
 * Dispatch admission is only defined for app-bound, non-archived
 * conversations. The success type deliberately has no non-app-bound arm, so
 * downstream lease minting cannot accidentally handle one as a lease binding.
 */
export function lookupAppBoundForConversation(
  db: Db,
  conversationId: ConversationId,
): Effect.Effect<AppBoundConversationLookup, never, never> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("conversations")
          .innerJoin("tasks", "tasks.id", "conversations.task_id")
          .select(["tasks.id as task_id", "tasks.app_id"])
          .where("conversations.id", "=", conversationId)
          .where("conversations.archived_at", "is", null)
          .where("tasks.app_id", "is not", null)
          .limit(1),
      );
      if (Option.isNone(rowOpt) || rowOpt.value.app_id === null) {
        return yield* Effect.dieMessage(
          `agent/dispatch/request requires an app-bound conversation: ${conversationId}`,
        );
      }
      const lookup: AppBoundConversationLookup = {
        _tag: "AppBound",
        taskId: rowOpt.value.task_id,
        appId: rowOpt.value.app_id,
      };
      return lookup;
    }).pipe(Effect.withSpan("lookupAppBoundForConversation")),
  );
}

// safer-arch-ignore no-trivial-sink-file: This query owns the invariant that dispatch admission only receives live app-bound conversations and keeps persistence details out of the admission service.
