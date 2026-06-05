import { Schema } from "effect";
import { brandedId } from "../transport/wire-string.js";

export const TaskId = brandedId("TaskId");
export type TaskId = Schema.Schema.Type<typeof TaskId>;

/**
 * The referenced task does not exist (or the caller cannot see it). Lives in the
 * task-id leaf so the `TaskReadAccess` capability can declare it as its
 * fail-closed not-found without a `capabilities → tasks` runtime import cycle.
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

export const AppId = brandedId("AppId");
export type AppId = Schema.Schema.Type<typeof AppId>;

export const DEFAULT_APP_ID = Schema.decodeSync(AppId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
);
