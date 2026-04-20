import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, brandedId, DateTimeString } from "../helpers.js";
import { AgentId, ConversationId } from "./primitives.js";

/**
 * Branded task identifier. Replaces `AppSessionId` from the session-era
 * protocol. A task is the only orchestration primitive — there is no
 * parallel session lifecycle.
 */
export const TaskId = brandedId("TaskId");

/**
 * Task lifecycle states. Mirrors the prior `AppSession` status enum; the
 * `waiting | active | failed | closed` vocabulary is preserved so the
 * rename is purely identifier-level.
 */
export const TaskStatusEnum = stringEnum([
  "waiting",
  "active",
  "failed",
  "closed",
]);

/**
 * Public task record. Replaces `AppSessionSchema`. Field shape is preserved
 * except `id` is re-branded to `TaskId`. Implementer keeps field-for-field
 * parity; no new fields in this slice.
 */
export const TaskSchema = Type.Object(
  {
    id: TaskId,
    appId: Type.String(),
    initiatorAgentId: AgentId,
    status: TaskStatusEnum,
    conversations: Type.Record(Type.String(), ConversationId),
    createdAt: DateTimeString,
    closedAt: Type.Optional(DateTimeString),
  },
  { additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;
export type TaskStatus = Static<typeof TaskStatusEnum>;
