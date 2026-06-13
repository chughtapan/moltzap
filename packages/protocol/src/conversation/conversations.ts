/**
 * @file Conversation RPC descriptors and notifications.
 */

import { Schema } from "effect";
import { AgentId, AgentNotFoundError } from "#identity/agents";
import { AgentClaimed } from "#identity/requirements";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { ListLimitSchema } from "#transport";
import { defineNotification, defineRpc } from "#transport";
import { dateTimeStringSchema, stringEnum } from "#transport";
import { ForbiddenError, InvalidParamsError } from "#transport";
import { ConversationInTask } from "#conversation/requirements";
import { TaskId, TaskNotFoundError } from "#task";
import {
  ConversationFullError,
  ConversationId,
  conversationSchema,
  ConversationNotFoundError,
  ParticipantNotAdmittedError,
} from "./types.js";

const DateTimeString = dateTimeStringSchema();
const ConversationSchema = conversationSchema();

// ═══════════════════════════════════════════════════════════════════
// app/conversation/create
// ═══════════════════════════════════════════════════════════════════

/**
 * TM-only: mint a new conversation under an existing task. Every
 * entry in `participants` MUST already appear in `task_participants`
 * for `taskId`; violations return `ParticipantNotAdmittedError`.
 *
 * - **Principal:** `AppPrincipal` head. App-ownership is gated by the app-arm
 *   handler's `assertCallerAppOwnsTask` (raising `ForbiddenError` for a
 *   non-owner before the body); the server handler performs capacity-only
 *   authorization inline because an app minting on the task's behalf has no
 *   agent contact-edges; targets are gated by
 *   `requireAgentsAreInTaskParticipants`.
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist
 * @error AgentNotFoundError when a listed participant agent does not exist
 * @error ParticipantNotAdmittedError when a participant is not admitted to the task
 * @error ConversationFullError when the conversation is at capacity
 */
export const TaskConversationCreate = defineRpc({
  name: "app/conversation/create",
  params: Schema.Struct({
    taskId: TaskId,
    name: Schema.optional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
    ),
    participants: Schema.Array(AgentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: ConversationSchema }),
  requires: [AppPrincipal],
  errors: [
    ForbiddenError,
    TaskNotFoundError,
    AgentNotFoundError,
    ParticipantNotAdmittedError,
    ConversationFullError,
  ],
});

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/list
// ═══════════════════════════════════════════════════════════════════

const TaskConversationListItemSchema = Schema.Struct({
  taskId: TaskId,
  conversation: ConversationSchema,
  participants: Schema.Array(AgentId),
});

/** Conversation list item returned by `agent/conversation/list`. */
export type TaskConversationListItem = Schema.Schema.Type<
  typeof TaskConversationListItemSchema
>;

/**
 * Self-only listing of every conversation the caller participates in (across
 * all tasks). No filter params; archived rows are included; callers filter
 * `archivedAt` locally.
 *
 * - **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
 * @error InvalidParamsError when the `cursor` does not decode
 * @error ConversationNotFoundError when a listed conversation's row vanished mid-projection
 */
export const TaskConversationList = defineRpc({
  name: "agent/conversation/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({
    items: Schema.Array(TaskConversationListItemSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [InvalidParamsError, ConversationNotFoundError],
});

const TaskConversationUpdateParamsSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("archive"),
    taskId: TaskId,
    conversationId: ConversationId,
  }),
  Schema.Struct({
    action: Schema.Literal("unarchive"),
    taskId: TaskId,
    conversationId: ConversationId,
  }),
  Schema.Struct({
    action: Schema.Literal("add-participant"),
    taskId: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-participant"),
    taskId: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  }),
);

export type TaskConversationUpdateParams = Schema.Schema.Type<
  typeof TaskConversationUpdateParamsSchema
>;

/**
 * TM-only conversation mutation surface. `app/conversation/update` owns
 * archive, unarchive, participant add, and participant remove semantics.
 *
 * - **Principal:** `AppPrincipal` head + `ConversationInTask`.
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist or is not open
 * @error ConversationNotFoundError when the conversation does not exist under the task
 * @error ParticipantNotAdmittedError when the agent is not admitted to the task
 */
export const TaskConversationUpdate = defineRpc({
  name: "app/conversation/update",
  params: TaskConversationUpdateParamsSchema,
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [
    ForbiddenError,
    TaskNotFoundError,
    ConversationNotFoundError,
    ParticipantNotAdmittedError,
  ],
});

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/* notifications
//
// Recipient fan-out:
//   - `created` → initial `participants` list
//   - `archived` / `unarchived` → post-mutation `conversation_participants`
//   - `participants/added` → post-mutation membership (newcomer included)
//   - `participants/removed` → pre-mutation membership (so the removed agent
//     still receives the notification)
// ═══════════════════════════════════════════════════════════════════

const TaskConversationCreatedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  name: Schema.optional(Schema.String),
  participants: Schema.Array(AgentId),
});

const TaskConversationArchivedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  archivedAt: DateTimeString,
});

const TaskConversationUnarchivedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
});

const TaskConversationParticipantsAddedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  addedAgentId: AgentId,
});

const TaskConversationParticipantsRemovedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  removedAgentId: AgentId,
  reason: stringEnum(["app_remove", "task_leave"]),
});

/** Notification payload for `agent/conversation/created`. */
export type TaskConversationCreatedNotification = Schema.Schema.Type<
  typeof TaskConversationCreatedNotificationSchema
>;

/** Notification payload for `agent/conversation/archived`. */
export type TaskConversationArchivedNotification = Schema.Schema.Type<
  typeof TaskConversationArchivedNotificationSchema
>;

/** Notification payload for `agent/conversation/unarchived`. */
export type TaskConversationUnarchivedNotification = Schema.Schema.Type<
  typeof TaskConversationUnarchivedNotificationSchema
>;

/** Notification payload for `agent/conversation/participants-added`. */
export type TaskConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;

/** Notification payload for `agent/conversation/participants-removed`. */
export type TaskConversationParticipantsRemovedNotification =
  Schema.Schema.Type<
    typeof TaskConversationParticipantsRemovedNotificationSchema
  >;

/** Pushed when a task conversation is created. */
export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "agent/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
);

/** Pushed when a task conversation is archived. */
export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  });

/** Pushed when a task conversation is unarchived. */
export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  });

/** Pushed when a participant is added to a task conversation. */
export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  });

/** Pushed when a participant is removed from a task conversation. */
export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  });

/** Agent-callable conversation RPC catalog. */
export const agentCallableConversationRpcMethods = [
  TaskConversationList,
] as const;

/** App-callable conversation RPC catalog. */
export const appCallableConversationRpcMethods = [
  TaskConversationCreate,
  TaskConversationUpdate,
] as const;

/** Conversation notification catalog. */
export const conversationNotifications = [
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const;
