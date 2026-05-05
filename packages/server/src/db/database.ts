// @generated — thin wrapper over kysely-codegen output for core schema.
// Run `pnpm db:generate` after changing src/app/core-schema.sql.

import type { Insertable, Selectable, Updateable } from "kysely";
import type {
  Agents,
  Contacts,
  ConversationKeys,
  ConversationParticipants,
  Conversations,
  EncryptionKeys,
  Messages,
  TaskParticipants,
  Tasks,
} from "./database.generated.js";

export type {
  AgentStatus,
  ContactStatus,
  ConversationType,
  EncryptionKeyStatus,
  ParticipantRole,
  TaskStatus,
} from "./database.generated.js";

export type {
  Agents,
  Contacts,
  ConversationKeys,
  ConversationParticipants,
  Conversations,
  EncryptionKeys,
  Messages,
  TaskParticipants,
  Tasks,
} from "./database.generated.js";

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
