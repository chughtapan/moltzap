/**
 * @file Conversation RPC descriptors and notifications.
 */
// safer-arch-ignore no-cross-domain-sibling-import: Conversation descriptors echo the opaque task label as part of their public wire contract.

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
import { taskId } from "../task/ids.js";
import { appId } from "#identity/apps";
import {
  ConversationFullError,
  conversationId,
  conversationSchema,
  ConversationNotFoundError,
} from "./types.js";
import { conversationNameSchema } from "./name.js";

const conversationSchemaValue = conversationSchema();

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/create
// ═══════════════════════════════════════════════════════════════════

/**
 * Mint a conversation naming its participants and the app that authorizes
 * it. The caller joins the conversation it creates.
 *
 * - **Principal:** `AgentPrincipal` + `ActiveAgent`. Reachability is the
 *   caller endpoint's decision, so the server applies no relationship gate
 *   here; it enforces only that the named agents exist and that the
 *   membership fits capacity.
 * @error AgentNotFoundError when a listed participant agent does not exist
 * @error ConversationFullError when the membership exceeds capacity
 * @relatedNotification agent/conversation/created
 */
export const agentConversationCreate = defineRpc({
  name: "agent/conversation/create",
  params: Schema.Struct({
    appId: appId,
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [AgentNotFoundError, ConversationFullError],
});

// ═══════════════════════════════════════════════════════════════════
// app/conversation/create
// ═══════════════════════════════════════════════════════════════════

/**
 * App-only: mint a conversation the calling app authorizes. The
 * conversation's app routing key is the caller's own `appId`.
 *
 * - **Principal:** `AppPrincipal` head. The server handler performs
 *   capacity-only authorization inline.
 * @error ForbiddenError when the caller may not create the conversation
 * @error AgentNotFoundError when a listed participant agent does not exist
 * @error ConversationFullError when the conversation is at capacity
 */
export const conversationCreate = defineRpc({
  name: "app/conversation/create",
  params: Schema.Struct({
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
  requires: [AppPrincipal],
  errors: [ForbiddenError, AgentNotFoundError, ConversationFullError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/list
// ═══════════════════════════════════════════════════════════════════

const conversationListItemSchema = Schema.Struct({
  taskId: Schema.optional(taskId),
  conversation: conversationSchemaValue,
  participants: Schema.Array(agentId),
});

/** Conversation list item returned by `agent/conversation/list`. */
export type ConversationListItem = Schema.Schema.Type<
  typeof conversationListItemSchema
>;

/**
 * Self-only listing of every conversation the caller participates in. No
 * filter params: the visibility contract is "caller in
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
    conversationId: conversationId,
    agentId: agentId,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-participant"),
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
 * - **Principal:** `AppPrincipal` head.
 * @error ForbiddenError when the caller does not own the conversation
 * @error ConversationNotFoundError when the conversation does not exist
 * @error ConversationFullError when adding the agent would exceed capacity
 */
export const conversationUpdate = defineRpc({
  name: "app/conversation/update",
  params: conversationUpdateParamsSchema,
  result: Schema.Struct({}),
  requires: [AppPrincipal],
  errors: [ForbiddenError, ConversationNotFoundError, ConversationFullError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/* notifications
//
// Recipient fan-out:
//   - `created` → initial `participants` list
//   - `participants/added` → post-mutation membership (newcomer included)
//   - `participants/removed` → pre-mutation membership (so the removed agent
//     still receives the notification)
//
// `taskId` is the opaque endpoint label echoed back when the creator pinned
// one; conversations without a label omit it.
// ═══════════════════════════════════════════════════════════════════

const conversationCreatedNotificationSchema = Schema.Struct({
  taskId: Schema.optional(taskId),
  conversationId: conversationId,
  name: Schema.optional(Schema.String),
  participants: Schema.Array(agentId),
});

const conversationParticipantsAddedNotificationSchema = Schema.Struct({
  taskId: Schema.optional(taskId),
  conversationId: conversationId,
  addedAgentId: agentId,
});

const conversationParticipantsRemovedNotificationSchema = Schema.Struct({
  taskId: Schema.optional(taskId),
  conversationId: conversationId,
  removedAgentId: agentId,
  reason: stringEnum(["app_remove"]),
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

/** Pushed when a conversation is created. */
export const conversationCreatedNotificationDefinition = defineNotification({
  name: "agent/conversation/created",
  params: conversationCreatedNotificationSchema,
});

/** Pushed when a participant is added to a conversation. */
export const conversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-added",
    params: conversationParticipantsAddedNotificationSchema,
  });

/** Pushed when a participant is removed from a conversation. */
export const conversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-removed",
    params: conversationParticipantsRemovedNotificationSchema,
  });

/** Agent-callable conversation RPC catalog. */
export const agentCallableConversationRpcMethods = [
  conversationList,
  agentConversationCreate,
] as const;

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
