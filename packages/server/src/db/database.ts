// @generated — thin wrapper over kysely-codegen output for core schema.
// Run `pnpm db:generate` after changing src/db/core-schema.sql.

import type { ColumnType, Selectable } from "kysely";
import type { AgentId, AppId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";

import type {
  Agents as RawAgents,
  Apps as RawApps,
  ConversationKeys as RawConversationKeys,
  ConversationParticipants as RawConversationParticipants,
  Conversations as RawConversations,
  EncryptionKeys as RawEncryptionKeys,
  Messages as RawMessages,
} from "./database.generated.js";

type Branded<T extends string> = ColumnType<T, string, string>;
type BrandedNullable<T extends string> = ColumnType<
  T | null,
  string | null,
  string | null
>;
type GeneratedBranded<T extends string> = ColumnType<
  T,
  string | undefined,
  string
>;

interface Agents extends Omit<RawAgents, "id" | "owner_user_id"> {
  id: GeneratedBranded<AgentId>;
  owner_user_id: Branded<UserId>;
}

interface Apps extends Omit<RawApps, "app_id"> {
  app_id: GeneratedBranded<AppId>;
}

interface ConversationKeys
  extends Omit<RawConversationKeys, "conversation_id"> {
  conversation_id: Branded<ConversationId>;
}

interface ConversationParticipants
  extends Omit<RawConversationParticipants, "agent_id" | "conversation_id"> {
  agent_id: Branded<AgentId>;
  conversation_id: Branded<ConversationId>;
}

interface Conversations
  extends Omit<RawConversations, "id" | "created_by_id" | "app_id"> {
  id: GeneratedBranded<ConversationId>;
  created_by_id: Branded<AgentId>;
  app_id: Branded<AppId>;
}

type EncryptionKeys = RawEncryptionKeys;

interface Messages
  extends Omit<
    RawMessages,
    "id" | "conversation_id" | "sender_id" | "task_id"
  > {
  id: GeneratedBranded<MessageId>;
  conversation_id: Branded<ConversationId>;
  sender_id: Branded<AgentId>;
  task_id: BrandedNullable<TaskId>;
}

/** Represents message row values. */
export type MessageRow = Selectable<Messages>;
/** Represents conversation key row values. */
export type ConversationKeyRow = Selectable<ConversationKeys>;

/** Describes database. */
export interface Database {
  agents: Agents;
  apps: Apps;
  conversations: Conversations;
  conversation_participants: ConversationParticipants;
  messages: Messages;
  encryption_keys: EncryptionKeys;
  conversation_keys: ConversationKeys;
}
