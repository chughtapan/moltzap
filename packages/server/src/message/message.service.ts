import {
  type Db,
  nextSnowflakeId,
  type MessageRow,
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "#db";
import {
  type Message,
  type MessageParts,
  type Part,
  decodeMessageParts,
  decodeMessagePartsText,
  messageReceivedNotificationDefinition,
} from "@moltzap/protocol/message";
import type { AgentId, AppId } from "@moltzap/protocol/identity";
import {
  messageId as MessageIdSchema,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import type { ConnectionId } from "@moltzap/protocol/socket";
import {
  DEFAULT_PAGE_LIMIT,
  type ForbiddenError,
  MAX_PAGE_LIMIT,
} from "@moltzap/protocol/rpc";
import { type Cause, Effect, Option, Schema } from "effect";
import { SqlError } from "@effect/sql/SqlError";
import type { ConversationService } from "#conversation";
import type { NetworkSendService } from "#network";
import {
  type EnvelopeEncryption,
  type Dek,
  deserializePayload,
  serializePayload,
} from "#db/crypto";

/**
 * Postgres returns bytea as Buffer, while PGlite returns Uint8Array. Normalize so .toString("utf-8") works.
 * @param v Value supplied to the operation.
 * @returns The to buf result.
 */
function toBuf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

// Content-free size metadata for OTel span attributes. Spans can egress to an
// operator OTLP collector, so they MUST NOT carry message body plaintext — the
// envelope is encrypted at rest and the body never belongs in telemetry. We
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

const PLAINTEXT_IV_BYTES = 12;
const PLAINTEXT_TAG_BYTES = 16;
const CONVERSATION_KEYS_ALIAS = "conversation_keys as ck";
const ENCRYPTION_KEYS_ALIAS = "encryption_keys as ek";
const COL_EK_VERSION = "ek.version";
const COL_CK_KEK_VERSION = "ck.kek_version";
const COL_CK_WRAPPED_DEK = "ck.wrapped_dek";
const COL_CK_DEK_VERSION = "ck.dek_version";
const COL_EK_ENCRYPTED_KEY = "ek.encrypted_key";
const COL_CK_CONVERSATION_ID = "ck.conversation_id";
const decodeMessageId = Schema.decodeUnknownSync(MessageIdSchema);

interface SendInsertResult {
  readonly message: Message;
  readonly parts: MessageParts;
  readonly conv: SendConversationRow;
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

interface SendConversationRow {
  readonly app_id: AppId;
}

interface EncryptedParts {
  readonly encrypted: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly dekVersion: number;
  readonly kekVersion: number;
}

interface ConversationDek {
  readonly dek: Dek;
  readonly dekVersion: number;
  readonly kekVersion: number;
}

interface ConversationKeyMaterialRow {
  readonly wrapped_dek: string;
  readonly dek_version: number;
  readonly kek_version: number;
  readonly encrypted_key: string;
}

interface ActiveKekRow {
  readonly version: number;
  readonly encrypted_key: string;
}

interface MessageServiceDeps {
  readonly db: Db;
  readonly conversations: ConversationService;
  readonly networkSend: NetworkSendService;
  readonly encryption: EnvelopeEncryption | null;
}

/**
 * `agent/message/send` server entry point. The `send` method persists the
 * message durably, then broadcasts it to every conversation participant
 * except the sender. The router is content-blind: it applies no
 * interpretation or policy to the message body.
 */
export class MessageService {
  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly networkSendService: NetworkSendService;
  private readonly encryption: EnvelopeEncryption | null;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
    this.encryption = deps.encryption;
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
        const conv = yield* this.readSendConversation(input.conversationId);
        const parts = input.parts;
        const encrypted = yield* this.encryptParts(input.conversationId, parts);
        const row = yield* this.insertMessageRow(input, encrypted);
        return {
          message: this.mapMessage(row, parts),
          parts,
          conv,
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
        .select(["app_id"])
        .where("id", "=", conversationId),
    );
  }

  private insertMessageRow(
    input: SendInsertInput,
    encryptedParts: EncryptedParts,
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
            parts_encrypted: encryptedParts.encrypted,
            parts_iv: encryptedParts.iv,
            parts_tag: encryptedParts.tag,
            dek_version: encryptedParts.dekVersion,
            kek_version: encryptedParts.kekVersion,
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
          return { messages };
        }.bind(this),
      ),
    );
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
        const dekCache = new Map<number, Dek>();
        const messages: Message[] = [];
        for (const row of rows) {
          const parts = yield* this.decryptPartsWithCache(row, dekCache);
          messages.push(this.mapMessage(row, parts));
        }
        messages.reverse();
        return messages;
      }.bind(this),
    );
  }

  private encryptParts(
    conversationId: ConversationId,
    parts: MessageParts,
  ): Effect.Effect<EncryptedParts> {
    const encryption = this.encryption;
    if (encryption === null) {
      return Effect.succeed(plaintextEncryptedParts(parts));
    }
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: MessageService) {
          const conversationDek = yield* this.getOrCreateConversationDek(
            conversationId,
            encryption,
          );
          const { ciphertext, iv, tag } = encryption.encryptMessage(
            parts,
            conversationDek.dek,
          );
          return {
            encrypted: ciphertext,
            iv,
            tag,
            dekVersion: conversationDek.dekVersion,
            kekVersion: conversationDek.kekVersion,
          };
        }.bind(this),
      ),
    );
  }

  private getOrCreateConversationDek(
    conversationId: ConversationId,
    encryption: EnvelopeEncryption,
  ): Effect.Effect<ConversationDek, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(
      function* (this: MessageService) {
        const keyRowOpt = yield* this.readLatestConversationKey(conversationId);
        if (Option.isSome(keyRowOpt)) {
          return unwrapConversationDek(encryption, keyRowOpt.value);
        }
        return yield* this.createConversationDek(conversationId, encryption);
      }.bind(this),
    );
  }

  private readLatestConversationKey(
    conversationId: ConversationId,
  ): Effect.Effect<Option.Option<ConversationKeyMaterialRow>, SqlError> {
    return takeFirstOption(
      this.db
        .selectFrom(CONVERSATION_KEYS_ALIAS)
        .innerJoin(ENCRYPTION_KEYS_ALIAS, COL_EK_VERSION, COL_CK_KEK_VERSION)
        .select([
          COL_CK_WRAPPED_DEK,
          COL_CK_DEK_VERSION,
          COL_CK_KEK_VERSION,
          COL_EK_ENCRYPTED_KEY,
        ])
        .where(COL_CK_CONVERSATION_ID, "=", conversationId)
        .orderBy(COL_CK_DEK_VERSION, "desc")
        .limit(1),
    );
  }

  private createConversationDek(
    conversationId: ConversationId,
    encryption: EnvelopeEncryption,
  ): Effect.Effect<ConversationDek, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(
      function* (this: MessageService) {
        const newDek = encryption.generateDek();
        const kekRow = yield* this.activeKekRow();
        const kek = encryption.decryptKek(
          deserializePayload(kekRow.encrypted_key),
        );
        const wrappedDek = encryption.wrapDek(newDek, kek);
        const insertedOpt = yield* takeFirstOption(
          this.db
            .insertInto("conversation_keys")
            .values({
              conversation_id: conversationId,
              dek_version: 1,
              wrapped_dek: serializePayload(wrappedDek),
              kek_version: kekRow.version,
            })
            .onConflict((oc) => oc.doNothing())
            .returningAll(),
        );
        if (Option.isSome(insertedOpt)) {
          return { dek: newDek, dekVersion: 1, kekVersion: kekRow.version };
        }
        return yield* this.readWinningConversationDek(
          conversationId,
          encryption,
        );
      }.bind(this),
    );
  }

  private activeKekRow(): Effect.Effect<ActiveKekRow, SqlError> {
    return takeFirstOption(
      this.db
        .selectFrom("encryption_keys")
        .select(["version", "encrypted_key"])
        .where("status", "=", "active")
        .orderBy("version", "desc")
        .limit(1),
    ).pipe(
      Effect.flatMap((kekRowOpt) =>
        Option.match(kekRowOpt, {
          onNone: () => Effect.die("No encryption key configured"),
          onSome: (row) => Effect.succeed(row),
        }),
      ),
    );
  }

  private readWinningConversationDek(
    conversationId: ConversationId,
    encryption: EnvelopeEncryption,
  ): Effect.Effect<ConversationDek, SqlError | Cause.NoSuchElementException> {
    return takeFirstOrFail(
      this.db
        .selectFrom(CONVERSATION_KEYS_ALIAS)
        .innerJoin(ENCRYPTION_KEYS_ALIAS, COL_EK_VERSION, COL_CK_KEK_VERSION)
        .select([
          COL_CK_WRAPPED_DEK,
          COL_CK_DEK_VERSION,
          COL_CK_KEK_VERSION,
          COL_EK_ENCRYPTED_KEY,
        ])
        .where(COL_CK_CONVERSATION_ID, "=", conversationId)
        .orderBy(COL_CK_DEK_VERSION, "desc")
        .limit(1),
      "winner DEK not found",
    ).pipe(Effect.map((row) => unwrapConversationDek(encryption, row)));
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

  private decryptPartsWithCache(
    row: MessageRow,
    dekCache: Map<number, Dek>,
  ): Effect.Effect<MessageParts> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: MessageService) {
          const dekVersion = row.dek_version;
          const encryption = this.encryption;

          if (encryption === null || dekVersion === 0) {
            return yield* decodeMessagePartsText(
              toBuf(row.parts_encrypted).toString("utf-8"),
            );
          }

          const dek = yield* this.dekForMessageRow(
            row,
            dekVersion,
            dekCache,
            encryption,
          );
          return yield* decodeMessageParts(
            encryption.decryptMessage(
              {
                ciphertext: toBuf(row.parts_encrypted),
                iv: toBuf(row.parts_iv),
                tag: toBuf(row.parts_tag),
              },
              dek,
            ),
          );
        }.bind(this),
      ),
    );
  }

  private dekForMessageRow(
    row: MessageRow,
    dekVersion: number,
    dekCache: Map<number, Dek>,
    encryption: EnvelopeEncryption,
  ): Effect.Effect<Dek, SqlError> {
    const cachedDek = dekCache.get(dekVersion);
    if (cachedDek !== undefined) {
      return Effect.succeed(cachedDek);
    }
    return Effect.gen(
      function* (this: MessageService) {
        const keyRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom(CONVERSATION_KEYS_ALIAS)
            .innerJoin(
              ENCRYPTION_KEYS_ALIAS,
              COL_EK_VERSION,
              COL_CK_KEK_VERSION,
            )
            .select([COL_CK_WRAPPED_DEK, COL_EK_ENCRYPTED_KEY])
            .where(COL_CK_CONVERSATION_ID, "=", row.conversation_id)
            .where(COL_CK_DEK_VERSION, "=", dekVersion),
        );
        if (Option.isNone(keyRowOpt)) {
          return yield* Effect.die("Decryption key not found");
        }
        const kek = encryption.decryptKek(
          deserializePayload(keyRowOpt.value.encrypted_key),
        );
        const dek = encryption.unwrapDek(
          deserializePayload(keyRowOpt.value.wrapped_dek),
          kek,
        );
        dekCache.set(dekVersion, dek);
        return dek;
      }.bind(this),
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

function plaintextEncryptedParts(parts: MessageParts): EncryptedParts {
  return {
    encrypted: Buffer.from(JSON.stringify(parts), "utf-8"),
    iv: Buffer.alloc(PLAINTEXT_IV_BYTES),
    tag: Buffer.alloc(PLAINTEXT_TAG_BYTES),
    dekVersion: 0,
    kekVersion: 0,
  };
}

function unwrapConversationDek(
  encryption: EnvelopeEncryption,
  row: ConversationKeyMaterialRow,
): ConversationDek {
  const kek = encryption.decryptKek(deserializePayload(row.encrypted_key));
  return {
    dek: encryption.unwrapDek(deserializePayload(row.wrapped_dek), kek),
    dekVersion: row.dek_version,
    kekVersion: row.kek_version,
  };
}
