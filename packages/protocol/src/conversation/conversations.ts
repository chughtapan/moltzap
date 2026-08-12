/**
 * @file Conversation RPC descriptors and notifications.
 */

import { Schema } from "effect";
import { agentId, AgentNotFoundError } from "#identity/agents";
import { ActiveAgent } from "#identity/requirements";
import { AuthenticatedAgent } from "#identity/principals";
import { InvalidParamsError, listLimitSchema } from "#transport";
import { defineNotification, defineRpc } from "#transport";
import {
  ConversationFullError,
  conversationId,
  conversationSchema,
  ConversationNotFoundError,
} from "./types.js";
import { conversationNameSchema } from "./name.js";

const conversationSchemaValue = conversationSchema();

// Wire bound on the create participants list. Mirrors the server's group
// capacity so an oversized request is rejected at decode, before any
// handler or database work runs; the server still enforces the effective
// limit (creator included) after deduplication.
const MAX_CREATE_PARTICIPANTS = 256;

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/create
// ═══════════════════════════════════════════════════════════════════

/**
 * Mint a conversation naming its participants. The caller joins the
 * conversation it creates; membership is fixed at creation.
 *
 * - **Principal:** `AuthenticatedAgent` + `ActiveAgent`. Reachability is the
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
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_CREATE_PARTICIPANTS),
    ),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [AgentNotFoundError, ConversationFullError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/list
// ═══════════════════════════════════════════════════════════════════

const conversationListItemSchema = Schema.Struct({
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
 * - **Principal:** `AuthenticatedAgent` head + `ActiveAgent` (active agent).
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
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError, ConversationNotFoundError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/conversation/* notifications
// ═══════════════════════════════════════════════════════════════════

const conversationCreatedNotificationSchema = Schema.Struct({
  conversationId: conversationId,
  name: Schema.optional(Schema.String),
  participants: Schema.Array(agentId),
});

/** Notification payload for `agent/conversation/created`. */
export type ConversationCreatedNotification = Schema.Schema.Type<
  typeof conversationCreatedNotificationSchema
>;

/** Pushed when a conversation is created. */
export const conversationCreatedNotificationDefinition = defineNotification({
  name: "agent/conversation/created",
  params: conversationCreatedNotificationSchema,
});
