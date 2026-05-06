import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { AgentId, TaskId } from "./primitives.js";

// Mirrors the `task_status` DB enum.
export const TaskStatusEnum = stringEnum([
  "waiting",
  "active",
  "failed",
  "closed",
]);

export type TaskStatus = Static<typeof TaskStatusEnum>;

export const TaskSchema = Type.Object(
  {
    id: TaskId,
    appId: Type.Union([Type.String(), Type.Null()]),
    initiatorAgentId: AgentId,
    status: TaskStatusEnum,
    // Phase 9b consumer-migration (sub-issue #460 round 3 R12): NOT NULL
    // by construction. `tasks/create` (R13) requires `tmEndpointAddress`
    // at insert time; the schema-level constraint at
    // `tasks.tm_endpoint_address` makes the null state unrepresentable.
    tmEndpointAddress: Type.String({ minLength: 1 }),
    startedAt: Type.Union([DateTimeString, Type.Null()]),
    endedAt: Type.Union([DateTimeString, Type.Null()]),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;

// `admittedAt = null` ⇒ invited but not yet admitted.
export const TaskParticipantSchema = Type.Object(
  {
    taskId: TaskId,
    agentId: AgentId,
    admittedAt: Type.Union([DateTimeString, Type.Null()]),
  },
  { additionalProperties: false },
);

export type TaskParticipant = Static<typeof TaskParticipantSchema>;
