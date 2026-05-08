// @generated — thin wrapper over kysely-codegen output for core schema.
// Run `pnpm db:generate` after changing src/app/core-schema.sql.

import type { ColumnType, Insertable, Selectable, Updateable } from "kysely";
import type { AgentId, ContactId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";

import type {
  Agents as RawAgents,
  Contacts as RawContacts,
  ConversationKeys as RawConversationKeys,
  ConversationParticipants as RawConversationParticipants,
  Conversations as RawConversations,
  EncryptionKeys,
  Messages as RawMessages,
  TaskParticipants as RawTaskParticipants,
  Tasks as RawTasks,
} from "./database.generated.js";

export type {
  AgentStatus,
  ContactStatus,
  ConversationType,
  EncryptionKeyStatus,
  TaskStatus,
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

export interface Agents extends Omit<RawAgents, "id" | "owner_user_id"> {
  id: GeneratedBranded<AgentId>;
  owner_user_id: BrandedNullable<UserId>;
}

export interface Contacts
  extends Omit<RawContacts, "id" | "contact_user_id" | "owner_user_id"> {
  id: GeneratedBranded<ContactId>;
  contact_user_id: Branded<UserId>;
  owner_user_id: Branded<UserId>;
}

export interface ConversationKeys
  extends Omit<RawConversationKeys, "conversation_id"> {
  conversation_id: Branded<ConversationId>;
}

export interface ConversationParticipants
  extends Omit<RawConversationParticipants, "agent_id" | "conversation_id"> {
  agent_id: Branded<AgentId>;
  conversation_id: Branded<ConversationId>;
}

export interface Conversations
  extends Omit<RawConversations, "id" | "created_by_id" | "task_id"> {
  id: GeneratedBranded<ConversationId>;
  created_by_id: Branded<AgentId>;
  task_id: Branded<TaskId>;
}

export type { EncryptionKeys };

export interface Messages
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

export interface TaskParticipants
  extends Omit<RawTaskParticipants, "agent_id" | "task_id"> {
  agent_id: Branded<AgentId>;
  task_id: Branded<TaskId>;
}

export interface Tasks extends Omit<RawTasks, "id" | "initiator_agent_id"> {
  id: GeneratedBranded<TaskId>;
  initiator_agent_id: Branded<AgentId>;
}

export type AgentRow = Selectable<Agents>;
export type NewAgent = Insertable<Agents>;
export type AgentUpdate = Updateable<Agents>;

export type ConversationRow = Selectable<Conversations>;
export type NewConversation = Insertable<Conversations>;
export type ConversationUpdate = Updateable<Conversations>;

export type ConversationParticipantRow = Selectable<ConversationParticipants>;
export type NewConversationParticipant = Insertable<ConversationParticipants>;
export type ConversationParticipantUpdate =
  Updateable<ConversationParticipants>;

export type MessageRow = Selectable<Messages>;
export type NewMessage = Insertable<Messages>;
export type MessageUpdate = Updateable<Messages>;

export type EncryptionKeyRow = Selectable<EncryptionKeys>;
export type NewEncryptionKey = Insertable<EncryptionKeys>;
export type EncryptionKeyUpdate = Updateable<EncryptionKeys>;

export type ConversationKeyRow = Selectable<ConversationKeys>;
export type NewConversationKey = Insertable<ConversationKeys>;
export type ConversationKeyUpdate = Updateable<ConversationKeys>;

export type ContactRow = Selectable<Contacts>;
export type NewContact = Insertable<Contacts>;
export type ContactUpdate = Updateable<Contacts>;

export type TaskRow = Selectable<Tasks>;
export type NewTask = Insertable<Tasks>;
export type TaskUpdate = Updateable<Tasks>;

export type TaskParticipantRow = Selectable<TaskParticipants>;
export type NewTaskParticipant = Insertable<TaskParticipants>;
export type TaskParticipantUpdate = Updateable<TaskParticipants>;

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
