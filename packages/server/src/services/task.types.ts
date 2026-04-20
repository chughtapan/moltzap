// Task-layer branded ID and discriminated-union types.
// Boundary types for the 12-method CRUD surface defined in spec #136.
// The task layer has no DM-specific schema (spec #136 invariant 3); DM
// uniqueness and immutability live in the default DM task manager (spec
// #137, app layer).

export type TaskId = string & { readonly __brand: "TaskId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type AppId = string & { readonly __brand: "AppId" };
export type Seq = bigint & { readonly __brand: "Seq" };

export type TaskStatus = "active" | "closed";

// Identity hint supplied by the caller at task creation. Determines whether
// `app_id` is persisted on the row. The task layer carries no DM/group
// discriminator — classification is a task-manager concern (spec #137).
export type TaskKind =
  | { readonly kind: "plain" }
  | { readonly kind: "app"; readonly appId: AppId };

export interface TaskRecord {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly appId: AppId | null;
  readonly initiatorAgentId: AgentId;
  readonly participantCount: number;
}

export interface ConversationRecord {
  readonly id: ConversationId;
  readonly taskId: TaskId;
  readonly name: string | null;
  readonly createdById: AgentId;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MessageRecord {
  readonly id: MessageId;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly senderId: AgentId;
  readonly seq: Seq;
  readonly replyToId: MessageId | null;
  readonly partsEncrypted: Uint8Array;
  readonly partsIv: Uint8Array;
  readonly partsTag: Uint8Array;
  readonly dekVersion: number;
  readonly kekVersion: number;
  readonly isDeleted: boolean;
  readonly createdAt: Date;
}

export interface CreateTaskInput {
  readonly kind: TaskKind;
  readonly initiatorAgentId: AgentId;
  readonly participantAgentIds: readonly AgentId[];
}

export interface CreateConversationInput {
  readonly taskId: TaskId;
  readonly createdById: AgentId;
  readonly name: string | null;
}

export interface StoreMessageInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly senderId: AgentId;
  readonly replyToId: MessageId | null;
  readonly partsEncrypted: Uint8Array;
  readonly partsIv: Uint8Array;
  readonly partsTag: Uint8Array;
  readonly dekVersion: number;
  readonly kekVersion: number;
}

export interface GetMessagesInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId | null;
  readonly limit: number;
  readonly cursor: Seq | null;
}

export interface GetMessagesSinceInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId | null;
  readonly sinceSeq: Seq;
  readonly limit: number;
}

export interface MessagePage {
  readonly messages: readonly MessageRecord[];
  readonly nextCursor: Seq | null;
}
