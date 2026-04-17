import type { Db } from "../db/client.js";
import type { Message, Part } from "@moltzap/protocol";
import { ErrorCodes, EventNames, eventFrame } from "@moltzap/protocol";
import { Effect, Option } from "effect";
import { SqlError } from "@effect/sql/SqlError";
import { RpcFailure, notFound, internalError } from "../runtime/index.js";
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
import type { AppHost } from "../app/app-host.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "../db/effect-kysely-toolkit.js";

/** pg returns bytea as Buffer, PGlite returns Uint8Array. Normalize so .toString("utf-8") works. */
function toBuf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

/**
 * Per-message delivery tracking writes one `message_deliveries` row per
 * recipient. For large group conversations that's O(participants) writes
 * per message, which isn't worth it — we skip delivery tracking and rely
 * on the presence signal alone.
 */
const DELIVERY_TRACKING_MAX_PARTICIPANTS = 20;

export class MessageService {
  constructor(
    private db: Db,
    private conversations: ConversationService,
    private broadcaster: Broadcaster,
    private encryption: EnvelopeEncryption | null,
    private delivery: DeliveryService,
    private appHost: AppHost | null = null,
  ) {}

  send(
    conversationId: string,
    inputParts: Part[],
    senderAgentId: string,
    replyToId?: string,
    excludeConnectionId?: string,
  ): Effect.Effect<Message, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        let parts = inputParts;
        yield* this.conversations.requireParticipant(
          conversationId,
          senderAgentId,
        );

        // Reject messages to archived conversations
        const convOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("archived_at")
            .where("id", "=", conversationId),
        );
        if (Option.isSome(convOpt) && convOpt.value.archived_at) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.ConversationArchived,
              message: "Conversation is archived",
            }),
          );
        }

        if (replyToId) {
          const replyExistsOpt = yield* takeFirstOption(
            this.db
              .selectFrom("messages")
              .select(sql`1`.as("one"))
              .where("id", "=", replyToId)
              .where("conversation_id", "=", conversationId),
          );
          if (Option.isNone(replyExistsOpt)) {
            return yield* Effect.fail(notFound("Reply target not found"));
          }
        }

        let patchedBy: string | undefined;
        if (this.appHost) {
          const hookResponse = yield* this.appHost.runBeforeMessageDelivery(
            conversationId,
            senderAgentId,
            parts,
            replyToId,
          );
          if (hookResponse?.result.block) {
            return yield* Effect.fail(
              new RpcFailure({
                code: ErrorCodes.HookBlocked,
                message: hookResponse.result.reason ?? "Blocked by app",
                data: hookResponse.result.feedback
                  ? { feedback: hookResponse.result.feedback }
                  : undefined,
              }),
            );
          }
          if (hookResponse?.result.patch?.parts) {
            const patched = hookResponse.result.patch.parts;
            if (patched.length >= 1 && patched.length <= 10) {
              parts = patched;
              patchedBy = hookResponse.appId;
            } else {
              yield* Effect.logWarning(
                "Hook returned invalid patch (must be 1-10 parts), ignoring patch",
              ).pipe(
                Effect.annotateLogs({
                  appId: hookResponse.appId,
                  patchLength: patched.length,
                }),
              );
            }
          }
        }

        const seq = nextSnowflakeId();
        const { encrypted, iv, tag, dekVersion, kekVersion } =
          yield* this.encryptParts(conversationId, parts);

        // Drop to the native promise API for bytea inserts; see the
        // header of effect-kysely-toolkit.ts for why the Proxy path
        // infinite-recurses on Buffer columns. `tryPromise` (not
        // `promise`) keeps driver errors (unique-violation, connection
        // drops, etc.) in the typed SqlError channel so
        // `catchSqlErrorAsDefect` narrows them into defects the RPC
        // router surfaces as InternalError rather than swallowing them
        // as unreachable.
        const row = yield* Effect.tryPromise({
          try: () =>
            this.db
              .insertInto("messages")
              .values({
                conversation_id: conversationId,
                sender_id: senderAgentId,
                seq: seq.toString(),
                reply_to_id: replyToId ?? null,
                parts_encrypted: encrypted,
                parts_iv: iv,
                parts_tag: tag,
                dek_version: dekVersion,
                kek_version: kekVersion,
              })
              .returningAll()
              .executeTakeFirstOrThrow(),
          catch: (cause) =>
            new SqlError({ cause, message: "insert messages failed" }),
        });

        const message = this.mapMessage(row, parts, patchedBy);

        const firstTextPart = parts.find((p) => p.type === "text");

        // Write-through to preview cache (plaintext available before encryption)
        if (firstTextPart && firstTextPart.type === "text") {
          this.conversations.updatePreviewCache(
            conversationId,
            firstTextPart.text,
          );
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
          yield* this.conversations.getParticipantAgentIds(conversationId);

        // Delivery tracking (only for small conversations)
        if (participants.length <= DELIVERY_TRACKING_MAX_PARTICIPANTS) {
          const recipients = participants.filter((id) => id !== senderAgentId);
          yield* this.delivery.recordSent(message.id, recipients);

          yield* this.delivery.recordDeliveredBatch(message.id, delivered);
        }

        yield* Effect.logInfo("Message sent").pipe(
          Effect.annotateLogs({ conversationId, messageId: message.id }),
        );

        return message;
      }),
    );
  }

  list(
    conversationId: string,
    requesterAgentId: string,
    options: {
      limit?: number;
    } = {},
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.conversations.requireParticipant(
          conversationId,
          requesterAgentId,
        );

        const limit = Math.min(options.limit ?? 50, 100);

        const rows = yield* this.db
          .selectFrom("messages")
          .selectAll()
          .where("conversation_id", "=", conversationId)
          .where("is_deleted", "=", false)
          .orderBy("seq", "desc")
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const resultRows = hasMore ? rows.slice(0, limit) : rows;

        const dekCache = new Map<number, Buffer>();
        const messages: Message[] = [];
        for (const row of resultRows) {
          const parts = yield* this.decryptPartsWithCache(row, dekCache);
          messages.push(this.mapMessage(row, parts));
        }

        // Return in ascending order
        messages.reverse();

        return { messages, hasMore };
      }),
    );
  }

  private encryptParts(
    conversationId: string,
    parts: Part[],
  ): Effect.Effect<
    {
      encrypted: Buffer;
      iv: Buffer;
      tag: Buffer;
      dekVersion: number;
      kekVersion: number;
    },
    RpcFailure
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
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
        let keyRowOpt = yield* takeFirstOption(
          this.db
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
            .limit(1),
        );

        let dekVersion: number;
        let kekVersion: number;
        let dek: Buffer;

        if (Option.isNone(keyRowOpt)) {
          const newDek = generateDek();
          const kekRowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("encryption_keys")
              .select(["version", "encrypted_key"])
              .where("status", "=", "active")
              .orderBy("version", "desc")
              .limit(1),
          );

          if (Option.isNone(kekRowOpt)) {
            return yield* Effect.fail(
              internalError("No encryption key configured"),
            );
          }
          const kekRow = kekRowOpt.value;
          const kek = this.encryption.decryptKek(
            deserializePayload(kekRow.encrypted_key),
          );
          const wrappedDek = wrapKey(newDek, kek);

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
            dek = newDek;
            dekVersion = 1;
            kekVersion = kekRow.version;
          } else {
            // Lost the race — another request created the DEK first, read theirs
            const winnerRow = yield* takeFirstOrFail(
              this.db
                .selectFrom("conversation_keys as ck")
                .innerJoin(
                  "encryption_keys as ek",
                  "ek.version",
                  "ck.kek_version",
                )
                .select([
                  "ck.wrapped_dek",
                  "ck.dek_version",
                  "ck.kek_version",
                  "ek.encrypted_key",
                ])
                .where("ck.conversation_id", "=", conversationId)
                .orderBy("ck.dek_version", "desc")
                .limit(1),
              "winner DEK not found",
            );
            const winnerKek = this.encryption.decryptKek(
              deserializePayload(winnerRow.encrypted_key),
            );
            dek = unwrapKey(
              deserializePayload(winnerRow.wrapped_dek),
              winnerKek,
            );
            dekVersion = winnerRow.dek_version;
            kekVersion = winnerRow.kek_version;
            keyRowOpt = Option.some(winnerRow);
          }
        } else {
          const keyRow = keyRowOpt.value;
          dekVersion = keyRow.dek_version;
          kekVersion = keyRow.kek_version;
          const kek = this.encryption.decryptKek(
            deserializePayload(keyRow.encrypted_key),
          );
          dek = unwrapKey(deserializePayload(keyRow.wrapped_dek), kek);
        }

        const { ciphertext, iv, tag } = this.encryption.encryptMessage(
          parts,
          dek,
        );
        return { encrypted: ciphertext, iv, tag, dekVersion, kekVersion };
      }),
    );
  }

  private decryptPartsWithCache(
    row: MessageRow,
    dekCache: Map<number, Buffer>,
  ): Effect.Effect<Part[], RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const dekVersion = row.dek_version;

        if (!this.encryption || dekVersion === 0) {
          return JSON.parse(
            toBuf(row.parts_encrypted).toString("utf-8"),
          ) as Part[];
        }

        let dek = dekCache.get(dekVersion);
        if (!dek) {
          const keyRowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("conversation_keys as ck")
              .innerJoin(
                "encryption_keys as ek",
                "ek.version",
                "ck.kek_version",
              )
              .select(["ck.wrapped_dek", "ek.encrypted_key"])
              .where("ck.conversation_id", "=", row.conversation_id)
              .where("ck.dek_version", "=", dekVersion),
          );

          if (Option.isNone(keyRowOpt)) {
            return yield* Effect.fail(
              internalError("Decryption key not found"),
            );
          }

          const kek = this.encryption.decryptKek(
            deserializePayload(keyRowOpt.value.encrypted_key),
          );
          dek = unwrapKey(deserializePayload(keyRowOpt.value.wrapped_dek), kek);
          dekCache.set(dekVersion, dek);
        }

        return this.encryption.decryptMessage(
          {
            ciphertext: toBuf(row.parts_encrypted),
            iv: toBuf(row.parts_iv),
            tag: toBuf(row.parts_tag),
          },
          dek,
        ) as Part[];
      }),
    );
  }

  private mapMessage(
    row: MessageRow,
    parts: Part[],
    patchedBy?: string,
  ): Message {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      replyToId: row.reply_to_id ?? undefined,
      parts,
      ...(patchedBy && { patchedBy }),
      createdAt: row.created_at.toISOString(),
    };
  }
}
