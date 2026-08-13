/**
 * @file Conversation RPC descriptors and notifications.
 */

import { Schema } from "effect";
import { agentId, AgentNotFoundError } from "#identity/agents";
import { ActiveAgent } from "#identity/requirements";
import { AuthenticatedAgent } from "#identity/principals";
import { defineRpc } from "#transport";
import { ConversationFullError, conversationSchema } from "./types.js";

const conversationSchemaValue = conversationSchema();

/** Display name accepted when a conversation is created. */
export const conversationNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
);

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

/** Agent-callable conversation RPC catalog. */
export const agentCallableConversationRpcMethods = [
  agentConversationCreate,
] as const;
