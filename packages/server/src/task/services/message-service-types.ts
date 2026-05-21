import type { Message, Part, TaskStatus } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";

export interface SendInsertResult {
  readonly message: Message;
  readonly parts: ReadonlyArray<Part>;
  readonly conv: SendConversationRow;
  readonly excludeConnectionId: string | undefined;
  readonly bypassTmRouting: boolean;
}

export interface SendMessageInput {
  readonly conversationId: ConversationId;
  readonly parts: ReadonlyArray<Part>;
  readonly senderAgentId: AgentId;
  readonly replyToId?: MessageId;
  readonly excludeConnectionId?: string;
  readonly bypassTmRouting?: boolean;
}

export interface SendInsertInput extends SendMessageInput {
  readonly bypassTmRouting: boolean;
}

export interface SendCommitInput {
  readonly carrier: SendInsertResult;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
}

export interface ResolveSendVerdictInput {
  readonly messageId: MessageId;
  readonly appId: string;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly parts: ReadonlyArray<Part>;
  readonly taskId: TaskId;
}

export interface SendConversationRow {
  readonly archived_at: Date | null;
  readonly task_id: TaskId;
  readonly app_id: string;
  readonly task_status: TaskStatus;
}

export interface EncryptedParts {
  readonly encrypted: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly dekVersion: number;
  readonly kekVersion: number;
}

export interface ConversationDek {
  readonly dek: Buffer;
  readonly dekVersion: number;
  readonly kekVersion: number;
}

export interface ConversationKeyMaterialRow {
  readonly wrapped_dek: string;
  readonly dek_version: number;
  readonly kek_version: number;
  readonly encrypted_key: string;
}

export interface ActiveKekRow {
  readonly version: number;
  readonly encrypted_key: string;
}
