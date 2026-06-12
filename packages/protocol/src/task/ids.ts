import { Schema, type Brand } from "effect";
import { formatString } from "#transport";

export type TaskId = string & Brand.Brand<"TaskId">;
export const TaskId: Schema.Schema<TaskId, string> = formatString("uuid").pipe(
  Schema.brand("TaskId"),
  Schema.annotations({ description: "Branded TaskId" }),
);

/**
 * The referenced task does not exist (or the caller cannot see it). Lives in the
 * task-id leaf so the `TaskReadAccess` requirement can declare it as its
 * fail-closed not-found without a `requirements -> tasks` runtime import cycle.
 */
export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFound",
  {
    message: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Unknown),
  },
) {
  static readonly message = "Task not found";
}
