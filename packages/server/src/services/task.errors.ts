// Typed error channels for the task CRUD surface (spec #136, invariant 4).
// Every public TaskService method returns an Effect whose E parameter is
// drawn from this union — no raw throws, no Promise<T>.

import { Data } from "effect";
import type {
  AgentId,
  ConversationId,
  MessageId,
  TaskId,
} from "./task.types.js";

export class TaskNotFound extends Data.TaggedError("TaskNotFound")<{
  readonly taskId: TaskId;
}> {}

export class TaskAlreadyClosed extends Data.TaggedError("TaskAlreadyClosed")<{
  readonly taskId: TaskId;
}> {}

export class ConversationNotFound extends Data.TaggedError(
  "ConversationNotFound",
)<{
  readonly conversationId: ConversationId;
}> {}

export class ConversationAlreadyClosed extends Data.TaggedError(
  "ConversationAlreadyClosed",
)<{
  readonly conversationId: ConversationId;
}> {}

export class ConversationNotInTask extends Data.TaggedError(
  "ConversationNotInTask",
)<{
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}> {}

export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{
  readonly agentId: AgentId;
}> {}

export class ParticipantNotInTask extends Data.TaggedError(
  "ParticipantNotInTask",
)<{
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}> {}

export class DuplicateParticipant extends Data.TaggedError(
  "DuplicateParticipant",
)<{
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}> {}

export class ReplyTargetNotInTask extends Data.TaggedError(
  "ReplyTargetNotInTask",
)<{
  readonly taskId: TaskId;
  readonly replyToId: MessageId;
}> {}

// Returned when createTask is called with zero participants. The task layer
// requires at least one member on creation. DM/group shape validation is
// not the task layer's concern — that lives in the DM task manager (spec #137).
export class InvalidParticipantCount extends Data.TaggedError(
  "InvalidParticipantCount",
)<{
  readonly provided: number;
  readonly expected: string;
}> {}

// Infrastructure failure (Kysely / Postgres). Surfaced as a tagged error so
// callers can discriminate retry-able DB errors from domain errors.
export class TaskDbError extends Data.TaggedError("TaskDbError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export type TaskServiceError =
  | TaskNotFound
  | TaskAlreadyClosed
  | ConversationNotFound
  | ConversationAlreadyClosed
  | ConversationNotInTask
  | AgentNotFound
  | ParticipantNotInTask
  | DuplicateParticipant
  | ReplyTargetNotInTask
  | InvalidParticipantCount
  | TaskDbError;
