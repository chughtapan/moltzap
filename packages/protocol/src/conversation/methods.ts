/**
 * @file Conversation RPC descriptors and notifications.
 */

import { Schema } from "effect";
import { AgentId, AgentNotFoundError } from "../identity/agents.js";
import { ListLimitSchema } from "../transport/pagination.js";
import { defineNotification, defineRpc } from "../transport/method.js";
import {
  AgentClaimed,
  AgentPrincipal,
  AppPrincipal,
} from "../transport/principal.js";
import { dateTimeStringSchema, stringEnum } from "../transport/wire-string.js";
import {
  ForbiddenError,
  InvalidParamsError,
} from "../transport/wire-errors.js";
import { ConversationInTask } from "../task/capabilities/index.js";
import { TaskId, TaskNotFoundError } from "../task/ids.js";
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
// task/conversation/create
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
  name: "task/conversation/create",
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
// task/conversation/list
// ═══════════════════════════════════════════════════════════════════

const TaskConversationListItemSchema = Schema.Struct({
  taskId: TaskId,
  conversation: ConversationSchema,
  participants: Schema.Array(AgentId),
});

/** Conversation list item returned by `task/conversation/list`. */
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
  name: "task/conversation/list",
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

// ═══════════════════════════════════════════════════════════════════
// task/conversation/archive
//
// The four conversation-targeted descriptors below share the IDENTICAL
// `[AppPrincipal, ConversationInTask]` requirement. App-ownership is gated in
// the app-arm handlers; `ConversationInTask` resolves the conversation's task
// membership. The wire descriptors here carry only their params/result shape.
// ═══════════════════════════════════════════════════════════════════

/**
 * TM-only: archive one conversation. Task stays open.
 *
 * - **Principal:** `AppPrincipal` head + `ConversationInTask` +
 *   `assertCallerAppOwnsTask` (see `task/close`).
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist or is not open
 * @error ConversationNotFoundError when the conversation does not exist under the task
 */
export const TaskConversationArchive = defineRpc({
  name: "task/conversation/archive",
  params: Schema.Struct({ taskId: TaskId, conversationId: ConversationId }),
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [ForbiddenError, TaskNotFoundError, ConversationNotFoundError],
});

// ═══════════════════════════════════════════════════════════════════
// task/conversation/unarchive
// ═══════════════════════════════════════════════════════════════════

/**
 * TM-only: reverse of `task/conversation/archive`.
 *
 * - **Principal:** `AppPrincipal` head + `ConversationInTask` +
 *   `assertCallerAppOwnsTask` (see `task/close`).
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist or is not open
 * @error ConversationNotFoundError when the conversation does not exist under the task
 */
export const TaskConversationUnarchive = defineRpc({
  name: "task/conversation/unarchive",
  params: Schema.Struct({ taskId: TaskId, conversationId: ConversationId }),
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [ForbiddenError, TaskNotFoundError, ConversationNotFoundError],
});

// ═══════════════════════════════════════════════════════════════════
// task/conversation/participants/add
// ═══════════════════════════════════════════════════════════════════

/**
 * TM-only: add an agent to one conversation. The agent MUST already appear in
 * `task_participants` for `taskId`; otherwise `ParticipantNotAdmittedError`.
 *
 * - **Principal:** `AppPrincipal` head + `ConversationInTask`. App-ownership is
 *   gated by the app-arm handler's `assertCallerAppOwnsTask` BEFORE
 *   `requireAgentsAreInTaskParticipants` (so a non-owner sees `ForbiddenError`,
 *   not the participant-admitted state probe).
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist or is not open
 * @error ParticipantNotAdmittedError when the agent is not admitted to the task
 */
export const TaskConversationAddParticipant = defineRpc({
  name: "task/conversation/participants/add",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  }),
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [ForbiddenError, TaskNotFoundError, ParticipantNotAdmittedError],
});

// ═══════════════════════════════════════════════════════════════════
// task/conversation/participants/remove
// ═══════════════════════════════════════════════════════════════════

/**
 * TM-only: remove an agent from one conversation. The agent stays in
 * `task_participants` (so they may still receive messages on other
 * conversations within the task).
 *
 * - **Principal:** `AppPrincipal` head + `ConversationInTask` +
 *   `assertCallerAppOwnsTask` (see `task/close`).
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist or is not open
 */
export const TaskConversationRemoveParticipant = defineRpc({
  name: "task/conversation/participants/remove",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  }),
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [ForbiddenError, TaskNotFoundError],
});

// ═══════════════════════════════════════════════════════════════════
// task/conversation/* notifications
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

/** Notification payload for `task/conversation/created`. */
export type TaskConversationCreatedNotification = Schema.Schema.Type<
  typeof TaskConversationCreatedNotificationSchema
>;

/** Notification payload for `task/conversation/archived`. */
export type TaskConversationArchivedNotification = Schema.Schema.Type<
  typeof TaskConversationArchivedNotificationSchema
>;

/** Notification payload for `task/conversation/unarchived`. */
export type TaskConversationUnarchivedNotification = Schema.Schema.Type<
  typeof TaskConversationUnarchivedNotificationSchema
>;

/** Notification payload for `task/conversation/participants/added`. */
export type TaskConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;

/** Notification payload for `task/conversation/participants/removed`. */
export type TaskConversationParticipantsRemovedNotification =
  Schema.Schema.Type<
    typeof TaskConversationParticipantsRemovedNotificationSchema
  >;

/** Pushed when a task conversation is created. */
export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "task/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
);

/** Pushed when a task conversation is archived. */
export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  });

/** Pushed when a task conversation is unarchived. */
export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  });

/** Pushed when a participant is added to a task conversation. */
export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  });

/** Pushed when a participant is removed from a task conversation. */
export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  });

/** Agent-callable conversation RPC catalog. */
export const agentCallableConversationRpcMethods = [
  TaskConversationList,
] as const;

/** App-callable conversation RPC catalog. */
export const appCallableConversationRpcMethods = [
  TaskConversationCreate,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
] as const;

/** Conversation notification catalog. */
export const conversationNotifications = [
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const;
