/**
 * @file Conversation RPC descriptors and notifications.
 */
// safer-arch-ignore no-cross-domain-sibling-import: Conversation descriptors carry task identifiers and task-not-found failures as part of their public wire contract.

import { Schema } from "effect";
import { agentId, AgentNotFoundError } from "#identity/agents";
import { ActiveAgent } from "#identity/requirements";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import {
  ForbiddenError,
  InvalidParamsError,
  listLimitSchema,
  stringEnum,
} from "#transport";
import { defineNotification, defineRpc } from "#transport/descriptor";
import { ConversationInTask } from "#conversation/requirements";
import { taskId, TaskNotFoundError } from "../task/ids.js";
import {
  ConversationFullError,
  conversationId,
  conversationSchema,
  ConversationNotFoundError,
  ParticipantNotAdmittedError,
} from "./types.js";
import { conversationNameSchema } from "./name.js";

const conversationSchemaValue = conversationSchema();

// ═══════════════════════════════════════════════════════════════════
// app/conversation/create
// ═══════════════════════════════════════════════════════════════════

/**
 * App-only: mint a new conversation under an existing task. Every
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
export const conversationCreate = defineRpc({
  name: "app/conversation/create",
  params: Schema.Struct({
    taskId: taskId,
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
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

const conversationListItemSchema = Schema.Struct({
  taskId: taskId,
  conversation: conversationSchemaValue,
  participants: Schema.Array(agentId),
});

/** Conversation list item returned by `agent/conversation/list`. */
export type ConversationListItem = Schema.Schema.Type<
  typeof conversationListItemSchema
>;

/**
 * Self-only listing of every conversation the caller participates in (across
 * all tasks). No filter params: the visibility contract is "caller in
 * `conversation_participants`", and any further narrowing is the endpoint's.
 *
 * - **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).
 * @error InvalidParamsError when the `cursor` does not decode
 * @error ConversationNotFoundError when a listed conversation's row vanished mid-projection
 */
export const conversationList = defineRpc({
  name: "agent/conversation/list",
  params: Schema.Struct({
    limit: listLimitSchema,
    cursor: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({
    items: Schema.Array(conversationListItemSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError, ConversationNotFoundError],
});

const conversationUpdateParamsSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("add-participant"),
    taskId: taskId,
    conversationId: conversationId,
    agentId: agentId,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-participant"),
    taskId: taskId,
    conversationId: conversationId,
    agentId: agentId,
  }),
);

/** Represents conversation update params values. */
export type ConversationUpdateParams = Schema.Schema.Type<
  typeof conversationUpdateParamsSchema
>;

/**
 * App-only conversation mutation surface. `app/conversation/update` owns
 * participant add and participant remove semantics.
 *
 * - **Principal:** `AppPrincipal` head + `ConversationInTask`.
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist or is not open
 * @error ConversationNotFoundError when the conversation does not exist under the task
 * @error ParticipantNotAdmittedError when the agent is not admitted to the task
 */
export const conversationUpdate = defineRpc({
  name: "app/conversation/update",
  params: conversationUpdateParamsSchema,
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
//   - `participants/added` → post-mutation membership (newcomer included)
//   - `participants/removed` → pre-mutation membership (so the removed agent
//     still receives the notification)
// ═══════════════════════════════════════════════════════════════════

const conversationCreatedNotificationSchema = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
  name: Schema.optional(Schema.String),
  participants: Schema.Array(agentId),
});

const conversationParticipantsAddedNotificationSchema = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
  addedAgentId: agentId,
});

const conversationParticipantsRemovedNotificationSchema = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
  removedAgentId: agentId,
  reason: stringEnum(["app_remove", "task_leave"]),
});

/** Notification payload for `agent/conversation/created`. */
export type ConversationCreatedNotification = Schema.Schema.Type<
  typeof conversationCreatedNotificationSchema
>;

/** Notification payload for `agent/conversation/participants-added`. */
export type ConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof conversationParticipantsAddedNotificationSchema
>;

/** Notification payload for `agent/conversation/participants-removed`. */
export type ConversationParticipantsRemovedNotification = Schema.Schema.Type<
  typeof conversationParticipantsRemovedNotificationSchema
>;

/** Pushed when a task conversation is created. */
export const conversationCreatedNotificationDefinition = defineNotification({
  name: "agent/conversation/created",
  params: conversationCreatedNotificationSchema,
});

/** Pushed when a participant is added to a task conversation. */
export const conversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-added",
    params: conversationParticipantsAddedNotificationSchema,
  });

/** Pushed when a participant is removed from a task conversation. */
export const conversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-removed",
    params: conversationParticipantsRemovedNotificationSchema,
  });

/** Agent-callable conversation RPC catalog. */
export const agentCallableConversationRpcMethods = [conversationList] as const;

/** App-callable conversation RPC catalog. */
export const appCallableConversationRpcMethods = [
  conversationCreate,
  conversationUpdate,
] as const;

/** Conversation notification catalog. */
export const conversationNotifications = [
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
] as const;
