import type { Message, Part, TaskStatus } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import type {
  AppId,
  ConversationId,
  MessageId,
  TaskId,
} from "@moltzap/protocol/task";

export interface SendInsertResult {
  readonly message: Message;
  readonly parts: ReadonlyArray<Part>;
  readonly conv: SendConversationRow;
  readonly excludeConnectionId: ConnectionId | undefined;
  readonly bypassTmRouting: boolean;
}

export interface SendMessageInput {
  readonly conversationId: ConversationId;
  readonly parts: ReadonlyArray<Part>;
  readonly senderAgentId: AgentId;
  readonly replyToId?: MessageId;
  readonly excludeConnectionId?: ConnectionId;
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
  readonly appId: AppId;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly parts: ReadonlyArray<Part>;
  readonly taskId: TaskId;
}

export interface SendConversationRow {
  readonly archived_at: Date | null;
  readonly task_id: TaskId;

  /**
   * Parent task's `app_id`. Consumed by `MessageService.sendCommit` to
   * route the per-message `messages/authorize` verdict request to the
   * right app.
   *
   * Typed as `string` because Kysely's row inference returns the raw
   * SQL column shape; consumers brand at the boundary
   * (`row.app_id as AppId`) at each read site.
   */
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
