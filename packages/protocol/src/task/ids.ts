import { Schema, type Brand } from "effect";
import { formatString } from "../transport/wire-string.js";

export type TaskId = string & Brand.Brand<"TaskId">;
export const TaskId: Schema.Schema<TaskId, string> = formatString("uuid").pipe(
  Schema.brand("TaskId"),
  Schema.annotations({ description: "Branded TaskId" }),
);

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

export type AppId = string & Brand.Brand<"AppId">;
export const AppId: Schema.Schema<AppId, string> = formatString("uuid").pipe(
  Schema.brand("AppId"),
  Schema.annotations({ description: "Branded AppId" }),
);

export const DEFAULT_APP_ID = Schema.decodeSync(AppId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
);
