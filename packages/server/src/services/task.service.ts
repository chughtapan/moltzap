// TaskService — layered-network refactor, slice B (spec #136).
//
// CRUD-only surface for the unified `tasks` entity. The service is the sole
// owner of read/write access to the `tasks`, `task_participants`,
// `conversations`, and `messages` tables. No routing, no hook dispatch, no
// payload parsing (invariant 4, spec #136).
//
// Every method returns `Effect<T, TaskServiceError, never>`. No method throws;
// the E channel is exhaustive and discriminated (principle 3, principle 4).

import type { Effect } from "effect";
import type { Db } from "../db/client.js";
import type {
  AgentId,
  ConversationId,
  ConversationRecord,
  CreateConversationInput,
  CreateTaskInput,
  CreateTaskOutput,
  GetMessagesInput,
  GetMessagesSinceInput,
  MessagePage,
  MessageRecord,
  StoreMessageInput,
  TaskId,
} from "./task.types.js";
import type { TaskServiceError } from "./task.errors.js";

export class TaskService {
  constructor(private readonly db: Db) {}

  // 1/9 — createTask.
  // Computes `participant_set_hash`, inserts (tasks, task_participants) in one
  // transaction, and relies on the partial unique index (spec AC 3) to
  // collapse duplicate DMs. On index conflict for a DM, returns the existing
  // task with `created: false`.
  createTask(
    input: CreateTaskInput,
  ): Effect.Effect<CreateTaskOutput, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 2/9 — closeTask.
  closeTask(taskId: TaskId): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 3/9 — createConversation.
  createConversation(
    input: CreateConversationInput,
  ): Effect.Effect<ConversationRecord, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 4/9 — closeConversation.
  closeConversation(
    conversationId: ConversationId,
  ): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 5/9 — addParticipant. Rejects with DmMutationForbidden on DM-shape tasks.
  addParticipant(
    taskId: TaskId,
    agentId: AgentId,
  ): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 6/9 — removeParticipant. Same DM-shape guard as addParticipant.
  removeParticipant(
    taskId: TaskId,
    agentId: AgentId,
  ): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 7/9 — storeMessage. Denormalizes task_id onto the row (spec goal 3).
  storeMessage(
    input: StoreMessageInput,
  ): Effect.Effect<MessageRecord, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 8/9 — getMessages. conversationId === null returns task-scoped messages.
  getMessages(
    input: GetMessagesInput,
  ): Effect.Effect<MessagePage, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 9/9 — getMessagesSince. Delta query for reconnect/resume.
  getMessagesSince(
    input: GetMessagesSinceInput,
  ): Effect.Effect<MessagePage, TaskServiceError, never> {
    throw new Error("not implemented");
  }
}
