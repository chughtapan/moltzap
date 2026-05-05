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
    tmEndpointAddress: Type.Union([Type.String(), Type.Null()]),
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
