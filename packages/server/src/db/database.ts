// @generated — thin wrapper over kysely-codegen output for core schema.
// Run `pnpm db:generate` after changing src/app/core-schema.sql.

import type { ColumnType, Selectable } from "kysely";
import type { AgentId, ContactId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";

import type {
  Agents as RawAgents,
  Contacts as RawContacts,
  ConversationKeys as RawConversationKeys,
  ConversationParticipants as RawConversationParticipants,
  Conversations as RawConversations,
  EncryptionKeys as RawEncryptionKeys,
  Messages as RawMessages,
  TaskParticipants as RawTaskParticipants,
  Tasks as RawTasks,
} from "./database.generated.js";
export type { ConversationType } from "./database.generated.js";

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
  owner_user_id: BrandedNullable<UserId>;
}

interface Contacts
  extends Omit<RawContacts, "id" | "contact_user_id" | "owner_user_id"> {
  id: GeneratedBranded<ContactId>;
  contact_user_id: Branded<UserId>;
  owner_user_id: Branded<UserId>;
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
  extends Omit<RawConversations, "id" | "created_by_id" | "task_id"> {
  id: GeneratedBranded<ConversationId>;
  created_by_id: Branded<AgentId>;
  task_id: Branded<TaskId>;
}

type EncryptionKeys = RawEncryptionKeys;

interface Messages
  extends Omit<
    RawMessages,
    "id" | "conversation_id" | "reply_to_id" | "sender_id" | "task_id"
  > {
  id: GeneratedBranded<MessageId>;
  conversation_id: Branded<ConversationId>;
  reply_to_id: BrandedNullable<MessageId>;
  sender_id: Branded<AgentId>;
  task_id: BrandedNullable<TaskId>;
}

interface TaskParticipants
  extends Omit<RawTaskParticipants, "agent_id" | "task_id"> {
  agent_id: Branded<AgentId>;
  task_id: Branded<TaskId>;
}

interface Tasks extends Omit<RawTasks, "id" | "initiator_agent_id"> {
  id: GeneratedBranded<TaskId>;
  initiator_agent_id: Branded<AgentId>;
}

export type MessageRow = Selectable<Messages>;
export type ContactRow = Selectable<Contacts>;
export type TaskRow = Selectable<Tasks>;
export type TaskParticipantRow = Selectable<TaskParticipants>;
export type ConversationKeyRow = Selectable<ConversationKeys>;

export interface Database {
  agents: Agents;
  conversations: Conversations;
  conversation_participants: ConversationParticipants;
  messages: Messages;
  encryption_keys: EncryptionKeys;
  conversation_keys: ConversationKeys;
  contacts: Contacts;
  tasks: Tasks;
  task_participants: TaskParticipants;
}
