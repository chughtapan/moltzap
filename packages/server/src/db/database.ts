// @generated — thin wrapper over kysely-codegen output for core schema.
// Run `pnpm db:generate` after changing src/db/core-schema.sql.

import type { ColumnType, Selectable } from "kysely";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";

import type {
  Agents as RawAgents,
  ConversationParticipants as RawConversationParticipants,
  Conversations as RawConversations,
  Messages as RawMessages,
} from "./database.generated.js";

type Branded<T extends string> = ColumnType<T, string, string>;
type GeneratedBranded<T extends string> = ColumnType<
  T,
  string | undefined,
  string
>;

interface Agents extends Omit<RawAgents, "id" | "owner_user_id"> {
  id: GeneratedBranded<AgentId>;
  owner_user_id: Branded<UserId>;
}

interface ConversationParticipants
  extends Omit<RawConversationParticipants, "agent_id" | "conversation_id"> {
  agent_id: Branded<AgentId>;
  conversation_id: Branded<ConversationId>;
}

interface Conversations extends Omit<RawConversations, "id" | "created_by_id"> {
  id: GeneratedBranded<ConversationId>;
  created_by_id: Branded<AgentId>;
}

interface Messages
  extends Omit<
    RawMessages,
    "id" | "conversation_id" | "sender_id" | "parts" | "seq"
  > {
  id: GeneratedBranded<MessageId>;
  conversation_id: Branded<ConversationId>;
  sender_id: Branded<AgentId>;

  /** The database identity is readable but never application-writable. */
  seq: ColumnType<string, never, never>;

  /**
   * Serialized `MessageParts`. The write side is `string` so every insert
   * goes through an explicit `JSON.stringify`; the read side stays `unknown`
   * so every read goes through the strict `decodeMessageParts` boundary.
   */
  parts: ColumnType<unknown, string, string>;
}

/** Represents message row values. */
export type MessageRow = Selectable<Messages>;

/** Describes database. */
export interface Database {
  agents: Agents;
  conversations: Conversations;
  conversation_participants: ConversationParticipants;
  messages: Messages;
}
