import { Schema, type Brand } from "effect";
import { formatString } from "#transport";

/**
 * Opaque endpoint label a caller may pin to a message or conversation. The
 * server carries and echoes it without interpretation.
 */
export type TaskId = string & Brand.Brand<"TaskId">;
/** Validates and decodes task id values. */
export const taskId: Schema.Schema<TaskId, string> = formatString("uuid").pipe(
  Schema.brand("TaskId"),
  Schema.annotations({ description: "Branded TaskId" }),
);
