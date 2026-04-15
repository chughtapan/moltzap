import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { Message, Part } from "@moltzap/protocol";
import { ErrorCodes, EventNames, eventFrame } from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";
import { nextSnowflakeId } from "../db/snowflake.js";
import type { ConversationService } from "./conversation.service.js";
import type { DeliveryService } from "./delivery.service.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import {
  type EnvelopeEncryption,
  generateDek,
  wrapKey,
  unwrapKey,
} from "../crypto/envelope.js";
import {
  serializePayload,
  deserializePayload,
} from "../crypto/serialization.js";
import { sql } from "kysely";
import type { MessageRow } from "../db/database.js";

/** Internal participant reference used by the DB layer. */
export interface ParticipantRef {
  type: "user" | "agent";
  id: string;
}

export class MessageService {
  constructor(
    private db: Db,
    private logger: Logger,
    private conversations: ConversationService,
    private broadcaster: Broadcaster,
    private encryption: EnvelopeEncryption | null,
    private delivery: DeliveryService,
  ) {}

  async send(
    conversationId: string,
    parts: Part[],
    senderRef: ParticipantRef,
    replyToId?: string,
    excludeConnectionId?: string,
  ): Promise<Message> {
    await this.conversations.requireParticipant(conversationId, senderRef);

    if (replyToId) {
      const replyExists = await this.db
        .selectFrom("messages")
        .select(sql`1`.as("one"))
        .where("id", "=", replyToId)
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      if (!replyExists) {
        throw new RpcError(ErrorCodes.NotFound, "Reply target not found");
      }
    }

    const seq = nextSnowflakeId();
    const { encrypted, iv, tag, dekVersion, kekVersion } =
      await this.encryptParts(conversationId, parts);

    const row = await this.db
      .insertInto("messages")
      .values({
        conversation_id: conversationId,
        sender_type: senderRef.type as "agent" | "user",
        sender_id: senderRef.id,
        seq: seq.toString(),
        reply_to_id: replyToId ?? null,
        parts_encrypted: encrypted,
        parts_iv: iv,
        parts_tag: tag,
        dek_version: dekVersion,
        kek_version: kekVersion,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const message = this.mapMessage(row, parts);

    const firstTextPart = parts.find((p) => p.type === "text");

    // Write-through to preview cache (plaintext available before encryption)
    if (firstTextPart && firstTextPart.type === "text") {
      this.conversations.updatePreviewCache(conversationId, firstTextPart.text);
    }

    // Broadcast to other participants
    const event = eventFrame(EventNames.MessageReceived, { message });
    const delivered = this.broadcaster.broadcastToConversation(
      conversationId,
      event,
      excludeConnectionId,
    );

    // Get all participants (shared between delivery tracking)
    const participants =
      await this.conversations.getParticipantRefs(conversationId);

    // Delivery tracking (only for small conversations)
    if (participants.length <= 20) {
      const recipients = participants.filter(
        (p) => !(p.type === senderRef.type && p.id === senderRef.id),
      );
      await this.delivery.recordSent(message.id, recipients);

      for (const d of delivered) {
        await this.delivery.recordDelivered(message.id, {
          type: d.type,
          id: d.id,
        });
      }
    }

    this.logger.info({ conversationId, messageId: message.id }, "Message sent");

    return message;
  }

  async list(
    conversationId: string,
    requesterRef: ParticipantRef,
    options: {
      limit?: number;
    } = {},
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    await this.conversations.requireParticipant(conversationId, requesterRef);

    const limit = Math.min(options.limit ?? 50, 100);

    const query = this.db
      .selectFrom("messages")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("is_deleted", "=", false)
      .orderBy("seq", "desc")
      .limit(limit + 1);

    const rows = await query.execute();

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    // Decrypt messages
    const messages = await Promise.all(
      resultRows.map(async (row) => {
        const parts = await this.decryptParts(row);
        return this.mapMessage(row, parts);
      }),
    );

    // Return in ascending order
    messages.reverse();

    return { messages, hasMore };
  }

  private async encryptParts(
    conversationId: string,
    parts: Part[],
  ): Promise<{
    encrypted: Buffer;
    iv: Buffer;
    tag: Buffer;
    dekVersion: number;
    kekVersion: number;
  }> {
    if (!this.encryption) {
      // No encryption configured — store plaintext as JSON in encrypted field
      const plaintext = Buffer.from(JSON.stringify(parts), "utf-8");
      return {
        encrypted: plaintext,
        iv: Buffer.alloc(12),
        tag: Buffer.alloc(16),
        dekVersion: 0,
        kekVersion: 0,
      };
    }

    // Get or create conversation DEK (race-safe: ON CONFLICT + re-read)
    let keyRow = await this.db
      .selectFrom("conversation_keys as ck")
      .innerJoin("encryption_keys as ek", "ek.version", "ck.kek_version")
      .select([
        "ck.wrapped_dek",
        "ck.dek_version",
        "ck.kek_version",
        "ek.encrypted_key",
      ])
      .where("ck.conversation_id", "=", conversationId)
      .orderBy("ck.dek_version", "desc")
      .limit(1)
      .executeTakeFirst();

    let dekVersion: number;
    let kekVersion: number;
    let dek: Buffer;

    if (!keyRow) {
      const newDek = generateDek();
      const kekRow = await this.db
        .selectFrom("encryption_keys")
        .select(["version", "encrypted_key"])
        .where("status", "=", "active")
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();

      if (!kekRow) {
        throw new RpcError(-32603, "No encryption key configured");
      }
      const kek = this.encryption.decryptKek(
        deserializePayload(kekRow.encrypted_key),
      );
      const wrappedDek = wrapKey(newDek, kek);

      const inserted = await this.db
        .insertInto("conversation_keys")
        .values({
          conversation_id: conversationId,
          dek_version: 1,
          wrapped_dek: serializePayload(wrappedDek),
          kek_version: kekRow.version,
        })
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted) {
        dek = newDek;
        dekVersion = 1;
        kekVersion = kekRow.version;
      } else {
        // Lost the race — another request created the DEK first, read theirs
        keyRow = await this.db
          .selectFrom("conversation_keys as ck")
          .innerJoin("encryption_keys as ek", "ek.version", "ck.kek_version")
          .select([
            "ck.wrapped_dek",
            "ck.dek_version",
            "ck.kek_version",
            "ek.encrypted_key",
          ])
          .where("ck.conversation_id", "=", conversationId)
          .orderBy("ck.dek_version", "desc")
          .limit(1)
          .executeTakeFirstOrThrow();
        const winnerKek = this.encryption.decryptKek(
          deserializePayload(keyRow.encrypted_key),
        );
        dek = unwrapKey(deserializePayload(keyRow.wrapped_dek), winnerKek);
        dekVersion = keyRow.dek_version;
        kekVersion = keyRow.kek_version;
      }
    } else {
      dekVersion = keyRow.dek_version;
      kekVersion = keyRow.kek_version;
      const kek = this.encryption.decryptKek(
        deserializePayload(keyRow.encrypted_key),
      );
      dek = unwrapKey(deserializePayload(keyRow.wrapped_dek), kek);
    }

    const { ciphertext, iv, tag } = this.encryption.encryptMessage(parts, dek);
    return { encrypted: ciphertext, iv, tag, dekVersion, kekVersion };
  }

  private async decryptParts(row: MessageRow): Promise<Part[]> {
    const dekVersion = row.dek_version;

    if (!this.encryption || dekVersion === 0) {
      return JSON.parse(row.parts_encrypted.toString("utf-8")) as Part[];
    }

    const conversationId = row.conversation_id;
    const keyRow = await this.db
      .selectFrom("conversation_keys as ck")
      .innerJoin("encryption_keys as ek", "ek.version", "ck.kek_version")
      .select(["ck.wrapped_dek", "ek.encrypted_key"])
      .where("ck.conversation_id", "=", conversationId)
      .where("ck.dek_version", "=", dekVersion)
      .executeTakeFirst();

    if (!keyRow) {
      throw new RpcError(-32603, "Decryption key not found");
    }

    const kek = this.encryption.decryptKek(
      deserializePayload(keyRow.encrypted_key),
    );
    const dek = unwrapKey(deserializePayload(keyRow.wrapped_dek), kek);

    return this.encryption.decryptMessage(
      {
        ciphertext: row.parts_encrypted,
        iv: row.parts_iv,
        tag: row.parts_tag,
      },
      dek,
    ) as Part[];
  }

  private mapMessage(row: MessageRow, parts: Part[]): Message {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      replyToId: row.reply_to_id ?? undefined,
      parts,
      createdAt: row.created_at.toISOString(),
    };
  }
}
