import type { TaskStatus } from "@moltzap/protocol/task";
import type { Message, Part } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { AppId, TaskId } from "@moltzap/protocol/task";
import type { Dek } from "../../db/crypto/envelope.js";

export interface SendInsertResult {
  readonly message: Message;
  readonly parts: ReadonlyArray<Part>;
  readonly conv: SendConversationRow;
  readonly excludeConnectionId: ConnectionId | undefined;
}

export interface SendMessageInput {
  readonly conversationId: ConversationId;
  readonly parts: ReadonlyArray<Part>;
  readonly senderAgentId: AgentId;
  readonly replyToId?: MessageId;
  readonly excludeConnectionId?: ConnectionId;
}

export type SendInsertInput = SendMessageInput;

export interface SendCommitInput {
  readonly carrier: SendInsertResult;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
}

export interface ResolveSendVerdictInput {
  readonly messageId: MessageId;
  readonly appId: AppId;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly parts: ReadonlyArray<Part>;
  readonly taskId: TaskId;
}

export interface SendConversationRow {
  readonly archived_at: Date | null;
  readonly task_id: TaskId;

  /** Parent task's authorizing app id. */
  readonly app_id: AppId;
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
  readonly dek: Dek;
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
