import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../helpers.js";
import { TaskId } from "./task.js";

/**
 * Emitted when a task enters the `active` status and is ready for
 * participants to send messages. Replaces `AppSessionReadyEventSchema`.
 * Field rename: `sessionId` → `taskId` (re-branded to `TaskId`).
 */
export const TaskReadyEventSchema = Type.Object(
  {
    taskId: TaskId,
    conversations: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Emitted when a task terminates in the `failed` status. Replaces
 * `AppSessionFailedEventSchema`.
 */
export const TaskFailedEventSchema = Type.Object(
  {
    taskId: TaskId,
    reason: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Emitted when a task terminates in the `closed` status. Replaces
 * `AppSessionClosedEventSchema`.
 */
export const TaskClosedEventSchema = Type.Object(
  {
    taskId: TaskId,
    closedBy: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Emitted when a task-layer hook exceeds its configured timeout.
 *
 * Fixes the pre-existing schema/emit mismatch: the server emits
 * `hookName: "on_task_active"` (renamed from `"on_session_active"` as part
 * of this slice) — now accepted by the enum alongside the previously valid
 * hook names. `sessionId` is renamed to `taskId`.
 */
export const TaskHookTimeoutEventSchema = Type.Object(
  {
    taskId: TaskId,
    appId: Type.String(),
    hookName: stringEnum([
      "before_message_delivery",
      "on_join",
      "on_close",
      "on_task_active",
    ]),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export type TaskReadyEvent = Static<typeof TaskReadyEventSchema>;
export type TaskFailedEvent = Static<typeof TaskFailedEventSchema>;
export type TaskClosedEvent = Static<typeof TaskClosedEventSchema>;
export type TaskHookTimeoutEvent = Static<typeof TaskHookTimeoutEventSchema>;
