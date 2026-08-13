import {
  type Db,
  DbTag,
  type MessageRow,
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "#db";
import {
  type Message,
  type MessageParts,
  type Part,
  messageReceivedNotificationDefinition,
} from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  messageId as MessageIdSchema,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol/conversation";
import type { ConnectionId } from "@moltzap/protocol/socket";
import { type Cause, Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import {
  type ConversationService,
  ConversationServiceTag,
} from "#conversation";
import { type NetworkSendService, NetworkSendServiceTag } from "#network";

// Content-free size metadata for OTel span attributes. Spans can egress to an
// operator OTLP collector, so they MUST NOT carry message body plaintext. We
// emit the text-part count and total text length (numbers) instead of the text
// itself, so operators can see message shape without reading content.
function textPartsMetadata(parts: readonly Part[]): {
  textPartCount: number;
  textLength: number;
} {
  let textPartCount = 0;
  let textLength = 0;
  for (const part of parts) {
    if (part.type === "text") {
      textPartCount += 1;
      textLength += part.text.length;
    }
  }
  return { textPartCount, textLength };
}

const decodeMessageId = Schema.decodeUnknownSync(MessageIdSchema);

interface SendInsertResult {
  readonly message: Message;
  readonly parts: MessageParts;
  readonly excludeConnectionId?: ConnectionId;
}

interface OrderedMessageInsert {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly parts: string;
  readonly createdAt: Date;
}

/**
 * Allocate a durable read position only after this writer owns the
 * conversation row lock. Checkpoints are conversation-scoped, so the lock
 * makes identity allocation follow same-conversation commit order while
 * unrelated conversations remain concurrent. The transaction retains the
 * lock until its insert commits.
 * @param db Database that owns both the lock and the insert transaction.
 * @param input Message values whose order is being committed.
 * @returns The committed message row.
 * @internal
 */
export function insertMessageInCheckpointOrder(
  db: Db,
  input: OrderedMessageInsert,
): Effect.Effect<MessageRow, SqlError> {
  return transaction(db, (trx) =>
    Effect.gen(function* () {
      yield* takeFirstOrFail(
        trx
          .selectFrom("conversations")
          .select("id")
          .where("id", "=", input.conversationId)
          .forUpdate(),
      );
      return yield* takeFirstOrFail(
        trx
          .insertInto("messages")
          .values({
            id: input.id,
            conversation_id: input.conversationId,
            sender_id: input.senderAgentId,
            parts: input.parts,
            created_at: input.createdAt,
          })
          .returningAll(),
      );
    }),
  ).pipe(
    Effect.withSpan("insertMessageInCheckpointOrder", {
      attributes: { conversationId: input.conversationId },
    }),
  );
}

interface SendMessageInput {
  readonly conversationId: ConversationId;
  readonly parts: MessageParts;
  readonly senderAgentId: AgentId;
  readonly excludeConnectionId?: ConnectionId;
}

type SendInsertInput = SendMessageInput;

interface SendCommitInput {
  readonly carrier: SendInsertResult;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
}

/** Existence projection of the conversation a send targets. */
interface SendConversationRow {
  readonly id: ConversationId;
}

interface MessageServiceDeps {
  readonly db: Db;
  readonly conversations: ConversationService;
  readonly networkSend: NetworkSendService;
}

/**
 * `agent/message/send` server entry point. The `send` method persists the
 * message durably, then broadcasts it to every conversation participant, the
 * sender included; only the connection that issued the send is left out, so a
 * sender holding several connections still sees its own message on the
 * others. The router is content-blind: it applies no interpretation or policy
 * to the message body.
 */
export class MessageService {
  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly networkSendService: NetworkSendService;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
  }

  sendInsert(input: SendInsertInput): Effect.Effect<SendInsertResult> {
    return catchSqlErrorAsDefect(this.sendInsertEffect(input));
  }

  private sendInsertEffect(
    input: SendInsertInput,
  ): Effect.Effect<SendInsertResult, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(
      function* (this: MessageService) {
        // `ConversationSendAccess` gates this method in the engine middleware
        // stack before the handler runs, so `send` requires no permission token in
        // its Env and trusts `input` (the handler's already-gated params).
        yield* this.readSendConversation(input.conversationId);
        const parts = input.parts;
        const row = yield* this.insertMessageRow(input);
        return {
          message: this.mapMessage(row, parts),
          parts,
          excludeConnectionId: input.excludeConnectionId,
        };
      }.bind(this),
    );
  }

  /**
   * Send-conversation projection consumed by the `ConversationSendAccess`
   * `obtain` to prove the conversation row exists before the send handler
   * runs.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The send-conversation row.
   */
  readSendConversation(
    conversationId: ConversationId,
  ): Effect.Effect<
    SendConversationRow,
    SqlError | Cause.NoSuchElementException
  > {
    return takeFirstOrFail(
      this.db
        .selectFrom("conversations")
        .select(["id"])
        .where("id", "=", conversationId),
    );
  }

  private insertMessageRow(
    input: SendInsertInput,
  ): Effect.Effect<MessageRow, SqlError> {
    const messageIdValue = decodeMessageId(crypto.randomUUID());
    return insertMessageInCheckpointOrder(this.db, {
      id: messageIdValue,
      conversationId: input.conversationId,
      senderAgentId: input.senderAgentId,
      parts: JSON.stringify(input.parts),
      createdAt: new Date(),
    });
  }

  /**
   * Broadcast and trace tail: participants-minus-sender fan-out.
   *
   * Participant fan-out is best-effort after the durable insert. Offline
   * participants are not a send failure: `broadcast` reports which agent IDs
   * were reached, and `recordTrace` observes the misses.
   * @param carrier Value supplied to the operation.
   * @param conversationId Value supplied to the operation.
   * @param senderAgentId Value supplied to the operation.
   * @returns The committed message.
   */
  sendCommit(
    carrier: SendInsertResult,
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<Message> {
    return catchSqlErrorAsDefect(
      this.sendCommitEffect({ carrier, conversationId, senderAgentId }),
    );
  }

  private sendCommitEffect(
    input: SendCommitInput,
  ): Effect.Effect<Message, SqlError> {
    return Effect.gen(
      function* (this: MessageService) {
        const participants = yield* this.conversations.getParticipantAgentIds(
          input.conversationId,
        );
        const recipientList = participants.filter(
          (id) => id !== input.senderAgentId,
        );
        const delivered = yield* this.broadcastCommittedMessage(
          input,
          recipientList,
        );
        yield* this.recordTrace(input, recipientList, delivered);
        yield* this.logMessageSent(input);
        return input.carrier.message;
      }.bind(this),
    );
  }

  private broadcastCommittedMessage(
    input: SendCommitInput,
    recipientList: readonly AgentId[],
  ): Effect.Effect<readonly AgentId[]> {
    const audience = Array.from(
      new Set([...recipientList, input.senderAgentId]),
    );
    return this.networkSendService
      .broadcastNotification(
        audience,
        messageReceivedNotificationDefinition,
        { message: input.carrier.message },
        {
          forConversation: input.conversationId,
          excludeConnectionId: input.carrier.excludeConnectionId,
        },
      )
      .pipe(Effect.map((result) => result.delivered));
  }

  private recordTrace(
    input: SendCommitInput,
    recipientList: readonly AgentId[],
    delivered: readonly AgentId[],
  ): Effect.Effect<void> {
    return Effect.gen(
      function* (this: MessageService) {
        const traceMetadata = yield* this.getTraceMessageMetadata(
          input.conversationId,
          input.senderAgentId,
        );
        const { textPartCount, textLength } = textPartsMetadata(
          input.carrier.parts,
        );
        yield* Effect.void.pipe(
          Effect.withSpan("moltzap.message.delivered", {
            attributes: {
              "moltzap.message.id": input.carrier.message.id,
              "moltzap.message.conversation_id": input.conversationId,
              "moltzap.message.sender_id": input.senderAgentId,
              "moltzap.message.created_at": input.carrier.message.createdAt,
              "moltzap.message.part_count": input.carrier.parts.length,
              "moltzap.message.text_part_count": textPartCount,
              "moltzap.message.text_length": textLength,
              "moltzap.channel.key": traceMetadata.channelKey,
              "moltzap.sender.display_name": traceMetadata.senderDisplayName,
              "moltzap.recipients": [...recipientList],
              "moltzap.delivered": [...delivered],
            },
          }),
        );
      }.bind(this),
    );
  }

  private logMessageSent(input: SendCommitInput): Effect.Effect<void> {
    return Effect.logInfo("Message sent").pipe(
      Effect.annotateLogs({
        conversationId: input.conversationId,
        messageId: input.carrier.message.id,
      }),
    );
  }

  send(input: SendMessageInput): Effect.Effect<Message> {
    return Effect.gen(
      function* (this: MessageService) {
        const carrier = yield* this.sendInsert(input);
        return yield* this.sendCommit(
          carrier,
          input.conversationId,
          input.senderAgentId,
        );
      }.bind(this),
    );
  }

  private getTraceMessageMetadata(
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<{ channelKey: string; senderDisplayName: string }> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: MessageService) {
          // Conversations carry no operator-facing key, so the raw
          // conversationId labels the channel for trace capture.
          const senderRowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("agents")
              .select(["display_name", "name"])
              .where("id", "=", senderAgentId)
              .limit(1),
          );

          const senderDisplayName = Option.match(senderRowOpt, {
            onNone: () => senderAgentId,
            onSome: (row) => row.display_name ?? row.name,
          });

          return {
            channelKey: conversationId,
            senderDisplayName,
          };
        }.bind(this),
      ),
    );
  }

  private mapMessage(row: MessageRow, parts: MessageParts): Message {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      parts,
      createdAt: row.created_at.toISOString(),
    };
  }
}

/** Implements message service tag. */
export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}

/** Provides the message service live runtime value. */
export const messageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
    });
  }).pipe(Effect.withSpan("MessageServiceLive")),
);
