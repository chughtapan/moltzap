import {
  READ_PLANE_PAGE_SIZE,
  type Db,
  type MessageRow,
  catchSqlErrorAsDefect,
  decodeConversationCheckpoint,
  decodeConversationReadCursor,
  encodeConversationCheckpoint,
  encodeConversationReadCursor,
  nextSnowflakeId,
  takeFirstOption,
  takeFirstOrFail,
} from "#db";
import {
  type ConversationCheckpoint,
  type Message,
  type MessageParts,
  type Part,
  decodeMessageParts,
  messageReceivedNotificationDefinition,
} from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  messageId as MessageIdSchema,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import type { ConnectionId } from "@moltzap/protocol/socket";
import {
  DEFAULT_PAGE_LIMIT,
  type ForbiddenError,
  InvalidParamsError,
  type ListCursor,
  MAX_PAGE_LIMIT,
} from "@moltzap/protocol/rpc";
import { type Cause, Effect, Option, Schema } from "effect";
import { SqlError } from "@effect/sql/SqlError";
import type { ConversationService } from "#conversation";
import type { NetworkSendService } from "#network";

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

// PostgreSQL adapters may materialize BIGINT as either a decimal string or a
// safe integer. Opaque read positions use one canonical decimal representation.
function storedSequenceString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

interface SendInsertResult {
  readonly message: Message;
  readonly parts: MessageParts;
  readonly excludeConnectionId?: ConnectionId;
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

interface ReadMessagesInput {
  readonly conversationId: ConversationId;
  readonly requesterAgentId: AgentId;
  readonly checkpoint?: ConversationCheckpoint;
  readonly cursor?: ListCursor;
}

interface ReadMessagesResult {
  readonly messages: Message[];
  readonly checkpoint: ConversationCheckpoint;
  readonly nextCursor?: ListCursor;
}

interface ReadWindow {
  readonly afterSeq: string;
  readonly throughSeq: string;
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

  close(): Effect.Effect<void> {
    return Effect.void;
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
    const createdAtIso = new Date().toISOString();
    return Effect.tryPromise({
      try: () =>
        this.db
          .insertInto("messages")
          .values({
            id: messageIdValue,
            conversation_id: input.conversationId,
            sender_id: input.senderAgentId,
            seq: nextSnowflakeId().toString(),
            parts: JSON.stringify(input.parts),
            created_at: new Date(createdAtIso),
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      catch: (cause) =>
        new SqlError({ cause, message: "insert messages failed" }),
    });
  }

  /**
   * Broadcast and trace tail: participants-minus-sender fan-out.
   *
   * Participant fan-out is best-effort after the durable insert. Offline
   * participants are not a send failure: `broadcast` reports which agent IDs
   * were reached, `recordTrace` observes the misses, and reconnecting clients
   * recover recent durable history within the requested `messages/list` limit.
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
          messageId: input.carrier.message.id,
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

  list(
    conversationId: ConversationId,
    requesterAgentId: AgentId,
    options: {
      limit?: number;
    } = {},
  ): Effect.Effect<{ messages: Message[] }, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: MessageService) {
          yield* this.conversations.assertConversationParticipant(
            conversationId,
            requesterAgentId,
          );
          const limit = Math.min(
            options.limit ?? DEFAULT_PAGE_LIMIT,
            MAX_PAGE_LIMIT,
          );
          const rows = yield* this.visibleMessageRows({
            conversationId,
            limit,
          });
          const messages = yield* this.messageRowsToMessages(rows);
          messages.reverse();
          return { messages };
        }.bind(this),
      ),
    );
  }

  read(
    input: ReadMessagesInput,
  ): Effect.Effect<ReadMessagesResult, ForbiddenError | InvalidParamsError> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: MessageService) {
          // Participation is checked before parsing either opaque token. An
          // inaccessible conversation therefore reveals nothing about token
          // validity or the conversation's stored position.
          yield* this.conversations.assertConversationParticipant(
            input.conversationId,
            input.requesterAgentId,
          );
          const window = yield* this.resolveReadWindow(input);
          const rows = yield* this.readMessageRows({
            conversationId: input.conversationId,
            ...window,
          });
          const hasMore = rows.length > READ_PLANE_PAGE_SIZE;
          const pageRows = hasMore ? rows.slice(0, READ_PLANE_PAGE_SIZE) : rows;
          const messages = yield* this.messageRowsToMessages(pageRows);
          const checkpoint = encodeConversationCheckpoint({
            conversationId: input.conversationId,
            throughSeq: window.throughSeq,
          });
          const last = pageRows.at(-1);
          const nextCursor =
            hasMore && last !== undefined
              ? encodeConversationReadCursor({
                  conversationId: input.conversationId,
                  throughSeq: window.throughSeq,
                  afterSeq: storedSequenceString(last.seq),
                })
              : undefined;
          return {
            messages,
            checkpoint,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          };
        }.bind(this),
      ),
    );
  }

  private resolveReadWindow(
    input: ReadMessagesInput,
  ): Effect.Effect<ReadWindow, InvalidParamsError | SqlError> {
    return Effect.gen(
      function* (this: MessageService) {
        if (input.checkpoint !== undefined && input.cursor !== undefined) {
          return yield* new InvalidParamsError({
            message: "checkpoint and cursor cannot be used together",
          });
        }
        if (input.cursor !== undefined) {
          return yield* decodeConversationReadCursor(
            input.cursor,
            input.conversationId,
          );
        }
        const priorThroughSeq =
          input.checkpoint === undefined
            ? "0"
            : (yield* decodeConversationCheckpoint(
                input.checkpoint,
                input.conversationId,
              )).throughSeq;
        const currentMaxSeq = yield* this.currentMaxVisibleSeq(
          input.conversationId,
        );
        return {
          afterSeq: priorThroughSeq,
          throughSeq:
            BigInt(priorThroughSeq) >= BigInt(currentMaxSeq)
              ? priorThroughSeq
              : currentMaxSeq,
        };
      }.bind(this),
    );
  }

  private currentMaxVisibleSeq(
    conversationId: ConversationId,
  ): Effect.Effect<string, SqlError> {
    return this.db
      .selectFrom("messages")
      .select((eb) => eb.fn.max<string>("seq").as("maxSeq"))
      .where("conversation_id", "=", conversationId)
      .where("is_deleted", "=", false)
      .pipe(Effect.map((rows) => storedSequenceString(rows[0]?.maxSeq ?? 0)));
  }

  private readMessageRows(args: {
    readonly conversationId: ConversationId;
    readonly afterSeq: string;
    readonly throughSeq: string;
  }): Effect.Effect<readonly MessageRow[], SqlError> {
    return this.db
      .selectFrom("messages")
      .selectAll()
      .where("conversation_id", "=", args.conversationId)
      .where("is_deleted", "=", false)
      .where("seq", ">", args.afterSeq)
      .where("seq", "<=", args.throughSeq)
      .orderBy("seq", "asc")
      .limit(READ_PLANE_PAGE_SIZE + 1);
  }

  private visibleMessageRows(args: {
    readonly conversationId: ConversationId;
    readonly limit: number;
  }): Effect.Effect<readonly MessageRow[], SqlError> {
    const { conversationId, limit } = args;
    return Effect.gen(
      function* (this: MessageService) {
        // Participation is the whole read gate (asserted in `list` before
        // this query runs): every participant sees every non-deleted message
        // in the conversation — the router broadcasts to all participants.
        return yield* this.db
          .selectFrom("messages")
          .selectAll()
          .where("conversation_id", "=", conversationId)
          .where("is_deleted", "=", false)
          .orderBy("seq", "desc")
          .limit(limit);
      }.bind(this),
    );
  }

  private messageRowsToMessages(
    rows: readonly MessageRow[],
  ): Effect.Effect<Message[]> {
    return Effect.gen(
      function* (this: MessageService) {
        const messages: Message[] = [];
        for (const row of rows) {
          // The `parts` column is stored plaintext; the strict decode is the
          // read boundary that keeps a hand-edited row out of the wire result.
          const parts = yield* decodeMessageParts(row.parts);
          messages.push(this.mapMessage(row, parts));
        }
        return messages;
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
