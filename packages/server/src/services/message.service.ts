import type { Db } from "../db/client.js";
import type { Message, Part } from "@moltzap/protocol";
import {
  ErrorCodes,
  MessageReceivedNotificationDefinition,
  agentId as protocolAgentId,
  conversationId as protocolConversationId,
  messageId as protocolMessageId,
  notificationFrame,
} from "@moltzap/protocol";
import { Duration, Effect, Fiber, Option, Schedule, Schema } from "effect";
import { SqlError } from "@effect/sql/SqlError";
import { RpcFailure, notFound, internalError } from "../runtime/index.js";
import { nextSnowflakeId } from "../db/snowflake.js";
import type { ConversationService } from "./conversation.service.js";
import type { DeliveryService } from "./delivery.service.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import { type WebhookClient, signWebhookPayload } from "../adapters/webhook.js";
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
import type { TraceCapture } from "../runtime-surface/trace-capture.js";
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
const PATCH_MIN_PARTS = 1;
const PATCH_MAX_PARTS = 10;
const DELIVERY_WEBHOOK_RETRY_BASE_SECONDS = 1;
const DELIVERY_WEBHOOK_BACKOFF_FACTOR = 2;
const DEFAULT_MESSAGE_HISTORY_LIMIT = 50;
const MAX_MESSAGE_HISTORY_LIMIT = 100;
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

/** Config for the optional `deliveryWebhook` fire-and-forget fanout. */
export interface DeliveryWebhookConfig {
  url: string;
  secret: string;
}

const DELIVERY_WEBHOOK_TIMEOUT_MS = 5_000;
const DELIVERY_WEBHOOK_MAX_ATTEMPTS = 3;

export class MessageService {
  private deliveryWebhookFibers = new Set<
    Fiber.RuntimeFiber<unknown, unknown>
  >();

  constructor(
    private db: Db,
    private conversations: ConversationService,
    private broadcaster: Broadcaster,
    private encryption: EnvelopeEncryption | null,
    private delivery: DeliveryService,
    private appHost: AppHost | null = null,
    private deliveryWebhook: DeliveryWebhookConfig | null = null,
    private webhookClient: WebhookClient | null = null,
    private traceCapture: TraceCapture | null = null,
  ) {}

  close(): Effect.Effect<void, never> {
    const pending = [...this.deliveryWebhookFibers];
    this.deliveryWebhookFibers.clear();
    return pending.length > 0 ? Fiber.interruptAll(pending) : Effect.void;
  }

  send(
    conversationId: string,
    inputParts: Part[],
    senderAgentId: string,
    replyToId?: string,
    excludeConnectionId?: string,
    dispatchLeaseId?: string,
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
            dispatchLeaseId,
          );
          if (hookResponse?.result.block) {
            const traceCapture = this.traceCapture;
            if (traceCapture) {
              yield* this.getTraceMessageMetadata(
                conversationId,
                senderAgentId,
              ).pipe(
                Effect.flatMap((traceMetadata) =>
                  traceCapture.record({
                    _tag: "HookBlocked",
                    hookName: "before_message_delivery",
                    conversationId,
                    channelKey: traceMetadata.channelKey,
                    senderAgentId,
                    senderDisplayName: traceMetadata.senderDisplayName,
                    reason: hookResponse.result.reason ?? "Blocked by app",
                    parts,
                    createdAt: new Date().toISOString(),
                  }),
                ),
                Effect.catchAll(() => Effect.void),
              );
            }
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
            if (
              patched.length >= PATCH_MIN_PARTS &&
              patched.length <= PATCH_MAX_PARTS
            ) {
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
        const event = notificationFrame(MessageReceivedNotificationDefinition, {
          message,
        });
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

        if (this.traceCapture) {
          const traceMetadata = yield* this.getTraceMessageMetadata(
            conversationId,
            senderAgentId,
          );
          yield* this.traceCapture.record({
            _tag: "Message",
            message,
            channelKey: traceMetadata.channelKey,
            senderDisplayName: traceMetadata.senderDisplayName,
            recipientAgentIds: participants.filter(
              (id) => id !== senderAgentId,
            ),
            deliveredAgentIds: delivered,
          });
        }

        // Fire delivery webhook to the offline recipients on a detached daemon
        // fiber so the `send` RPC returns immediately. `recordDeliveredBatch`
        // above only runs for small conversations, so `delivered` is the
        // authoritative presence signal for this message.
        if (this.deliveryWebhook && this.webhookClient) {
          const deliveredSet = new Set(delivered);
          const offlineRecipientAgentIds = participants.filter(
            (id) => id !== senderAgentId && !deliveredSet.has(id),
          );
          if (offlineRecipientAgentIds.length > 0) {
            this.spawnDeliveryWebhook({
              conversationId,
              messageId: message.id,
              offlineRecipientAgentIds,
            });
          }
        }

        yield* Effect.logInfo("Message sent").pipe(
          Effect.annotateLogs({ conversationId, messageId: message.id }),
        );

        return message;
      }),
    );
  }

  private spawnDeliveryWebhook(body: {
    conversationId: string;
    messageId: string;
    offlineRecipientAgentIds: string[];
  }): void {
    const fibers = this.deliveryWebhookFibers;
    const fiber = Effect.runFork(
      this.fireDeliveryWebhook(body),
    ) as Fiber.RuntimeFiber<unknown, unknown>;
    fibers.add(fiber);
    fiber.addObserver(() => {
      fibers.delete(fiber);
    });
  }

  private fireDeliveryWebhook(body: {
    conversationId: string;
    messageId: string;
    offlineRecipientAgentIds: string[];
  }): Effect.Effect<void, never> {
    const cfg = this.deliveryWebhook;
    const client = this.webhookClient;
    // Defensive: TS narrowing doesn't propagate across the fork boundary
    // in `spawnDeliveryWebhook`, so we re-check here.
    if (!cfg || !client) return Effect.void;

    const payload = JSON.stringify(body);
    const signature = signWebhookPayload(cfg.secret, payload);

    // 1s base, doubled per attempt, ±50% jitter. `intersect` with `recurs`
    // caps the retry count at `MAX_ATTEMPTS - 1` so total attempts = MAX.
    const retrySchedule = Schedule.intersect(
      Schedule.exponential(
        Duration.seconds(DELIVERY_WEBHOOK_RETRY_BASE_SECONDS),
        DELIVERY_WEBHOOK_BACKOFF_FACTOR,
      ).pipe(Schedule.jittered),
      Schedule.recurs(DELIVERY_WEBHOOK_MAX_ATTEMPTS - 1),
    );

    return client
      .call({
        url: cfg.url,
        event: "messages.delivered",
        body: undefined,
        bodyJson: payload,
        timeoutMs: DELIVERY_WEBHOOK_TIMEOUT_MS,
        headers: { "X-MoltZap-Signature": signature },
        // Fire-and-forget: receivers typically reply 204/empty, and
        // anything they do send is discarded by `Effect.asVoid` below.
        schema: Schema.Unknown,
      })
      .pipe(
        Effect.retry(retrySchedule),
        Effect.asVoid,
        Effect.catchAll((err) =>
          Effect.logError("Delivery webhook dropped after retries").pipe(
            Effect.annotateLogs({
              err: String(err),
              url: cfg.url,
              messageId: body.messageId,
            }),
          ),
        ),
      );
  }

  list(
    conversationId: string,
    requesterAgentId: string,
    options: {
      limit?: number;
      sinceSeq?: string;
    } = {},
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.conversations.requireParticipant(
          conversationId,
          requesterAgentId,
        );

        const limit = Math.min(
          options.limit ?? DEFAULT_MESSAGE_HISTORY_LIMIT,
          MAX_MESSAGE_HISTORY_LIMIT,
        );

        let qb = this.db
          .selectFrom("messages")
          .selectAll()
          .where("conversation_id", "=", conversationId)
          .where("is_deleted", "=", false);
        if (options.sinceSeq !== undefined) {
          qb = qb.where("seq", ">", options.sinceSeq);
        }
        const rows = yield* qb.orderBy("seq", "desc").limit(limit + 1);

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
            iv: Buffer.alloc(PLAINTEXT_IV_BYTES),
            tag: Buffer.alloc(PLAINTEXT_TAG_BYTES),
            dekVersion: 0,
            kekVersion: 0,
          };
        }

        // Get or create conversation DEK (race-safe: ON CONFLICT + re-read)
        let keyRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom(CONVERSATION_KEYS_ALIAS)
            .innerJoin(
              ENCRYPTION_KEYS_ALIAS,
              COL_EK_VERSION,
              COL_CK_KEK_VERSION,
            )
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
                .selectFrom(CONVERSATION_KEYS_ALIAS)
                .innerJoin(
                  ENCRYPTION_KEYS_ALIAS,
                  COL_EK_VERSION,
                  COL_CK_KEK_VERSION,
                )
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

  private getTraceMessageMetadata(
    conversationId: string,
    senderAgentId: string,
  ): Effect.Effect<
    { channelKey: string; senderDisplayName: string },
    RpcFailure
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        // Phase 7 cutover: `app_session_conversations` is gone. Trace
        // metadata used the (session, conversationId, conversation_key)
        // triple to label the channel by its manifest-declared role
        // (e.g. "town_square" instead of a UUID). The tasks/* layer does
        // not carry per-task conversation keys; falling back to the raw
        // conversationId preserves the trace shape and correctness
        // (string identity stable across runs) while losing the
        // semantic-key flavour. Phase 9's TM topology will introduce a
        // new role-naming surface if needed.
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
      id: protocolMessageId(row.id),
      conversationId: protocolConversationId(row.conversation_id),
      senderId: protocolAgentId(row.sender_id),
      replyToId:
        row.reply_to_id === null
          ? undefined
          : protocolMessageId(row.reply_to_id),
      parts,
      ...(patchedBy && { patchedBy }),
      createdAt: row.created_at.toISOString(),
    };
  }
}
