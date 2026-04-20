// TaskService — layered-network refactor, slice B (spec #136).
//
// CRUD-only surface for the unified `tasks` entity. The service is the sole
// owner of read/write access to the `tasks`, `task_participants`,
// `conversations`, and `messages` tables. No routing, no hook dispatch, no
// payload parsing (invariant 4, spec #136).
//
// The task layer has no concept of DM vs group (invariant 3). DM uniqueness
// and immutability are enforced by the default DM task manager (spec #137)
// before calls reach this service.
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
  GetMessagesInput,
  GetMessagesSinceInput,
  MessagePage,
  MessageRecord,
  StoreMessageInput,
  TaskId,
  TaskRecord,
} from "./task.types.js";
import type { TaskServiceError } from "./task.errors.js";

export class TaskService {
  constructor(private readonly db: Db) {}

  // 1/12 — createTask. Unconditionally inserts a new task row + its
  // task_participants rows in one transaction. No DM uniqueness collapse
  // here (the task layer has no DM concept); the DM task manager handles
  // idempotence via SELECT-before-INSERT using listParticipants / getTask.
  createTask(
    input: CreateTaskInput,
  ): Effect.Effect<TaskRecord, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 2/12 — closeTask.
  closeTask(taskId: TaskId): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 3/12 — createConversation.
  createConversation(
    input: CreateConversationInput,
  ): Effect.Effect<ConversationRecord, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 4/12 — closeConversation.
  closeConversation(
    conversationId: ConversationId,
  ): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 5/12 — addParticipant. Mechanical CRUD — inserts into task_participants
  // regardless of the current participant count. DM-shape rejection is a
  // task-manager concern (spec #137), not the task layer's.
  addParticipant(
    taskId: TaskId,
    agentId: AgentId,
  ): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 6/12 — removeParticipant. Mechanical CRUD counterpart to addParticipant;
  // no DM-shape check.
  removeParticipant(
    taskId: TaskId,
    agentId: AgentId,
  ): Effect.Effect<void, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 7/12 — storeMessage. Denormalizes task_id onto the row (spec goal 3).
  storeMessage(
    input: StoreMessageInput,
  ): Effect.Effect<MessageRecord, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 8/12 — getMessages. conversationId === null returns task-scoped messages.
  getMessages(
    input: GetMessagesInput,
  ): Effect.Effect<MessagePage, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 9/12 — getMessagesSince. Delta query for reconnect/resume.
  getMessagesSince(
    input: GetMessagesSinceInput,
  ): Effect.Effect<MessagePage, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 10/12 — getTask. Metadata read: returns identity and lifecycle fields of
  // the task row plus participant_count (computed at read time from
  // task_participants). Narrow error channel: TaskNotFound | TaskDbError.
  getTask(
    taskId: TaskId,
  ): Effect.Effect<TaskRecord, TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 11/12 — listParticipants. Returns the agent ids currently in
  // task_participants for the given task. TaskNotFound | TaskDbError.
  listParticipants(
    taskId: TaskId,
  ): Effect.Effect<readonly AgentId[], TaskServiceError, never> {
    throw new Error("not implemented");
  }

  // 12/12 — listConversations. Returns the conversation ids owned by the
  // given task (archived + active). TaskNotFound | TaskDbError.
  listConversations(
    taskId: TaskId,
  ): Effect.Effect<readonly ConversationId[], TaskServiceError, never> {
    throw new Error("not implemented");
  }
}
