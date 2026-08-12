/** @file Authored Kysely row contract for the standalone PGlite schema. */

import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ColumnType, Selectable } from "kysely";

type AgentStatus = "active" | "suspended";
type Branded<T extends string> = ColumnType<T, string, string>;
type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;
type GeneratedBranded<T extends string> = ColumnType<
  T,
  string | undefined,
  string
>;
type Int8 = ColumnType<
  string,
  bigint | number | string,
  bigint | number | string
>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;

interface Agents {
  api_key_id: string;
  api_key_secret_hash: string;
  created_at: Generated<Timestamp>;
  description: string | null;
  display_name: string | null;
  id: GeneratedBranded<AgentId>;
  name: string;
  owner_user_id: Branded<UserId>;
  status: Generated<AgentStatus>;
  updated_at: Generated<Timestamp>;
}

interface ConversationParticipants {
  agent_id: Branded<AgentId>;
  conversation_id: Branded<ConversationId>;
}

interface Conversations {
  created_at: Generated<Timestamp>;
  created_by_id: Branded<AgentId>;
  id: GeneratedBranded<ConversationId>;
  name: string | null;
  updated_at: Generated<Timestamp>;
}

interface Messages {
  conversation_id: Branded<ConversationId>;
  created_at: Generated<Timestamp>;
  id: GeneratedBranded<MessageId>;
  is_deleted: Generated<boolean>;

  /**
   * Serialized `MessageParts`. The write side is `string` so every insert
   * goes through an explicit `JSON.stringify`; the read side stays `unknown`
   * so every read goes through the strict `decodeMessageParts` boundary.
   */
  parts: ColumnType<unknown, string, string>;
  sender_id: Branded<AgentId>;
  seq: Int8;
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
