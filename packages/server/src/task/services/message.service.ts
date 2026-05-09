import type { Db } from "../../db/client.js";
import type { Message, Part, TaskStatus } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type {
  ConversationId,
  MessageId,
  TaskId,
  TmDecision,
} from "@moltzap/protocol/task";

/**
 * #529 reshape additive — carrier returned by `sendInsert`, consumed by
 * `sendCommit`. Lets the messages handler drive the durable insert and
 * the post-insert routing/broadcast as separate Effects so the lease-
 * registry `Effect.acquireUseRelease` boundary lines up between
 * `claim` (acquire), `sendInsert + sendCommit` (use), and
 * `finalize | rollback` (release).
 *
 * Architect plan §3 carrier shape: the carrier intentionally avoids
 * pre-computing post-insert metadata (participants, trace) — those
 * stay inside `sendCommit` to keep the carrier small and to mirror
 * the behavior of the pre-split `send`.
 */
export interface SendInsertResult {
  readonly message: Message;
  readonly parts: ReadonlyArray<Part>;
  readonly conv: {
    readonly archived_at: Date | null;
    readonly task_id: TaskId;
    readonly tm_endpoint_address: string;
    readonly task_status: string;
  };
  readonly excludeConnectionId: string | undefined;
  readonly bypassTmRouting: boolean;
}
import {
  ConversationArchivedError,
  ForbiddenError,
  HookBlockedError,
  MessageReceivedNotificationDefinition,
  NotFoundError,
  TaskClosedError,
} from "@moltzap/protocol";
import {
  isEndpointAddress,
  type EndpointAddress,
} from "@moltzap/protocol/network";
import { Duration, Effect, Fiber, Option, Schedule, Schema } from "effect";
import { SqlError } from "@effect/sql/SqlError";

export type MessageServiceError =
  | ConversationArchivedError
  | ForbiddenError
  | HookBlockedError
  | NotFoundError
  | TaskClosedError;
import { nextSnowflakeId } from "../../db/snowflake.js";
import type { ConversationService } from "./conversation.service.js";
import type { NetworkSendService } from "../../network/network-send.js";
import {
  opaquePayload,
  RecipientNotResolved,
  WriteFailed,
} from "../../network/network-send.js";
import {
  type WebhookClient,
  signWebhookPayload,
} from "../../adapters/webhook.js";
import {
  type EnvelopeEncryption,
  generateDek,
  wrapKey,
  unwrapKey,
} from "../../crypto/envelope.js";
import {
  serializePayload,
  deserializePayload,
} from "../../crypto/serialization.js";
import { sql } from "kysely";
import type { MessageRow } from "../../db/database.js";
import type { TraceCapture } from "../../runtime-surface/trace-capture.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "../../db/effect-kysely-toolkit.js";

/** pg returns bytea as Buffer, PGlite returns Uint8Array. Normalize so .toString("utf-8") works. */
function toBuf(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

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

export interface MessageServiceDeps {
  readonly db: Db;
  readonly conversations: ConversationService;
  readonly networkSend: NetworkSendService;
  readonly encryption: EnvelopeEncryption | null;
  readonly deliveryWebhook: DeliveryWebhookConfig | null;
  readonly webhookClient: WebhookClient | null;
  readonly traceCapture: TraceCapture | null;
}

/**
 * `messages/send` server entry point. The `send` method runs the
 * structural checks against `(conversations ⋈ tasks)`, persists the
 * message, then fires the TM-routing `network.send` and the
 * conversation broadcast (in that order, so a failed insert never
 * surfaces a notification for a `messageId` the DB never committed).
 *
 * Branch over `task.status`:
 * - `{closed, failed}` → fail closed with `TaskClosed`; no insert.
 * - `{waiting, active}` → insert + TM dispatch + broadcast.
 *
 * `network.send` is one-way: the TM observes the message and acts via
 * CRUD (`tasks/storeMessage` etc.), with no return-channel verdict.
 * Failure surfaces only liveness (TM unreachable) and the `TaskClosed`
 * structural gate.
 *
 * `bypassTmRouting` covers the TM-authored insert at
 * `tasks/storeMessage`: without the flag, the TM would receive a
 * `messages/received` frame for the message it just persisted (a
 * self-loop on every store).
 */
export class MessageService {
  private deliveryWebhookFibers = new Set<
    Fiber.RuntimeFiber<unknown, unknown>
  >();

  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly networkSendService: NetworkSendService;
  private readonly encryption: EnvelopeEncryption | null;
  private readonly deliveryWebhook: DeliveryWebhookConfig | null;
  private readonly webhookClient: WebhookClient | null;
  private readonly traceCapture: TraceCapture | null;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
    this.encryption = deps.encryption;
    this.deliveryWebhook = deps.deliveryWebhook;
    this.webhookClient = deps.webhookClient;
    this.traceCapture = deps.traceCapture;
  }

  close(): Effect.Effect<void, never> {
    const pending = [...this.deliveryWebhookFibers];
    this.deliveryWebhookFibers.clear();
    return pending.length > 0 ? Fiber.interruptAll(pending) : Effect.void;
  }

  /**
   * #529 reshape additive — the durable insert subset of `send`.
   * Returns a `SendInsertResult` carrier that {@link sendCommit}
   * consumes for the routing/broadcast/trace tail. `send` composes both
   * for backward compatibility with all existing callers.
   *
   * Architect plan §3 carrier shape: `{ message, parts, conv,
   * excludeConnectionId, bypassTmRouting }`.
   */
  /**
   * #560: CAS-guarded UPDATE of `messages.tm_decision` after the
   * `messages/authorize` gate resolves. Caller-side state machine:
   * row is inserted with `{tag: "pending"}` in {@link sendInsert};
   * THIS method transitions to `{tag: "forward", recipients}` or
   * `{tag: "block", reason}` exactly once.
   *
   * The CAS guard restricts the UPDATE to rows currently in the
   * `pending` tag. Two concurrent transitions (real verdict racing a
   * timeout-synthesized fallback) cannot both succeed: whichever
   * commits first wins, the loser sees `committed: false` and
   * skips the dependent broadcast. Architect plan §9 risk R11
   * names this race and the mitigation.
   *
   * Kysely query builder per memory `feedback_no_raw_sql`; the
   * implementer uses Kysely's `.returning()` for the rowcount-equiv
   * to compute `committed`.
   *
   * Stub: `implement-*` fills in the body.
   */
  recordTmDecision(
    messageId: MessageId,
    verdict: TmDecision,
  ): Effect.Effect<{ committed: boolean }, never> {
    return Effect.dieMessage(
      `MessageService.recordTmDecision: not implemented (#560 architect stub) for ${messageId} tag=${verdict.tag}`,
    );
  }

  sendInsert(
    conversationId: ConversationId,
    inputParts: Part[],
    senderAgentId: AgentId,
    replyToId?: MessageId,
    excludeConnectionId?: string,
    bypassTmRouting = false,
  ): Effect.Effect<SendInsertResult, MessageServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const parts = inputParts;
        yield* this.conversations.requireParticipant(
          conversationId,
          senderAgentId,
        );

        const conv = yield* takeFirstOrFail(
          this.db
            .selectFrom("conversations as c")
            .innerJoin("tasks as t", "t.id", "c.task_id")
            .select([
              "c.archived_at",
              "c.task_id",
              "t.tm_endpoint_address as tm_endpoint_address",
              "t.status as task_status",
            ])
            .where("c.id", "=", conversationId),
        );
        if (conv.archived_at) {
          return yield* Effect.fail(new ConversationArchivedError({}));
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
            return yield* Effect.fail(
              new NotFoundError({ message: "Reply target not found" }),
            );
          }
        }

        if (!bypassTmRouting && !taskStatusAcceptsMessages(conv.task_status)) {
          return yield* Effect.fail(
            new TaskClosedError({
              message: `Task is ${conv.task_status}`,
              data: {
                reason: "TaskClosed",
                taskId: conv.task_id,
                status: conv.task_status,
              },
            }),
          );
        }

        const seq = nextSnowflakeId();
        const messageIdValue = crypto.randomUUID() as MessageId;
        const createdAtIso = new Date().toISOString();

        const { encrypted, iv, tag, dekVersion, kekVersion } =
          yield* this.encryptParts(conversationId, parts);

        const row = yield* Effect.tryPromise({
          try: () =>
            this.db
              .insertInto("messages")
              .values({
                id: messageIdValue,
                conversation_id: conversationId,
                sender_id: senderAgentId,
                seq: seq.toString(),
                reply_to_id: replyToId ?? null,
                parts_encrypted: encrypted,
                parts_iv: iv,
                parts_tag: tag,
                dek_version: dekVersion,
                kek_version: kekVersion,
                task_id: conv.task_id,
                created_at: new Date(createdAtIso),
              })
              .returningAll()
              .executeTakeFirstOrThrow(),
          catch: (cause) =>
            new SqlError({ cause, message: "insert messages failed" }),
        });

        const message = this.mapMessage(row, parts);

        return {
          message,
          parts,
          conv: {
            archived_at: conv.archived_at,
            task_id: conv.task_id,
            tm_endpoint_address: conv.tm_endpoint_address,
            task_status: conv.task_status,
          },
          excludeConnectionId,
          bypassTmRouting,
        };
      }),
    );
  }

  /**
   * #529 reshape additive — TM routing + broadcast + trace + delivery
   * webhook tail. Sequencing preserves the pre-split order (architect
   * plan §9 risk #9): TM route → preview → fan-out → trace → webhook.
   */
  sendCommit(
    carrier: SendInsertResult,
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<Message, MessageServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const { message, parts, conv, excludeConnectionId, bypassTmRouting } =
          carrier;

        if (!bypassTmRouting) {
          const tmAddr = yield* decodeTmEndpointAddress(
            conv.tm_endpoint_address,
          );
          const tmFrame = MessageReceivedNotificationDefinition.encode({
            message,
          });
          yield* this.networkSendService
            .send(tmAddr, opaquePayload(JSON.stringify(tmFrame)))
            .pipe(Effect.mapError(deliveryErrorToHookBlocked));
        }

        const firstTextPart = parts.find((p) => p.type === "text");
        if (firstTextPart && firstTextPart.type === "text") {
          this.conversations.updatePreviewCache(
            conversationId,
            firstTextPart.text,
          );
        }

        const participants =
          yield* this.conversations.getParticipantAgentIds(conversationId);

        const event = MessageReceivedNotificationDefinition.encode({
          message,
        });
        const eventPayload = opaquePayload(JSON.stringify(event));
        const broadcastResult = yield* this.networkSendService.broadcast(
          participants,
          eventPayload,
          {
            forConversation: conversationId,
            excludeConnectionId,
          },
        );
        const delivered: readonly string[] = broadcastResult.delivered;

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

  send(
    conversationId: ConversationId,
    inputParts: Part[],
    senderAgentId: AgentId,
    replyToId?: MessageId,
    /** Sender's WS connection — skipped by the broadcast fan-out so
     * the RPC reply is not echoed back as a notification. */
    excludeConnectionId?: string,
    /** Skip the TM-routing branch. `tasks/storeMessage` sets this to
     * avoid a self-loop when the TM persists a message it admitted. */
    bypassTmRouting = false,
  ): Effect.Effect<Message, MessageServiceError> {
    return Effect.gen(this, function* () {
      const carrier = yield* this.sendInsert(
        conversationId,
        inputParts,
        senderAgentId,
        replyToId,
        excludeConnectionId,
        bypassTmRouting,
      );
      return yield* this.sendCommit(carrier, conversationId, senderAgentId);
    });
  }

  private spawnDeliveryWebhook(body: {
    conversationId: ConversationId;
    messageId: MessageId;
    offlineRecipientAgentIds: AgentId[];
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
    conversationId: ConversationId;
    messageId: MessageId;
    offlineRecipientAgentIds: AgentId[];
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
    conversationId: ConversationId,
    requesterAgentId: AgentId,
    options: {
      limit?: number;
      sinceSeq?: string;
    } = {},
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, ForbiddenError> {
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
    conversationId: ConversationId,
    parts: Part[],
  ): Effect.Effect<
    {
      encrypted: Buffer;
      iv: Buffer;
      tag: Buffer;
      dekVersion: number;
      kekVersion: number;
    },
    never
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
            return yield* Effect.die("No encryption key configured");
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
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<{ channelKey: string; senderDisplayName: string }, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        // No per-task conversation key in the tasks/* layer; the raw
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
      }),
    );
  }

  private decryptPartsWithCache(
    row: MessageRow,
    dekCache: Map<number, Buffer>,
  ): Effect.Effect<Part[]> {
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
            return yield* Effect.die("Decryption key not found");
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

  private mapMessage(row: MessageRow, parts: Part[]): Message {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      replyToId: row.reply_to_id === null ? undefined : row.reply_to_id,
      parts,
      createdAt: row.created_at.toISOString(),
    };
  }
}

/**
 * Exhaustive predicate over `tasks.status`. Returns true iff the task
 * is in a state that can still receive messages (`waiting | active`);
 * `closed | failed` fail-closed via the `TaskClosed` RPC error. The
 * `default: absurd(s)` arm forces every future addition to the
 * `TaskStatus` enum (Postgres + protocol) to surface here as a
 * compile error rather than silently falling through to "accept".
 */
function taskStatusAcceptsMessages(status: TaskStatus): boolean {
  switch (status) {
    case "waiting":
    case "active":
      return true;
    case "closed":
    case "failed":
      return false;
    default: {
      const _absurd: never = status;
      return _absurd;
    }
  }
}

/** Decode raw `tasks.tm_endpoint_address`. A malformed non-null row is
 * data corruption and dies as a defect rather than silently mis-routing. */
function decodeTmEndpointAddress(raw: string): Effect.Effect<EndpointAddress> {
  if (isEndpointAddress(raw)) return Effect.succeed(raw);
  return Effect.die(`Malformed tm_endpoint_address in tasks row: ${raw}`);
}

/** Translate a `network.send` `DeliveryError` into `HookBlockedError`.
 * Both tags signal a caller-recoverable TM-offline / socket-fail. */
function deliveryErrorToHookBlocked(
  err: RecipientNotResolved | WriteFailed,
): HookBlockedError {
  if (err instanceof RecipientNotResolved) {
    return new HookBlockedError({
      message: "Task manager is not reachable",
      data: { reason: "RecipientNotResolved", to: String(err.to) },
    });
  }
  return new HookBlockedError({
    message: "Task manager dispatch failed",
    data: {
      reason: "WriteFailed",
      to: String(err.to),
      cause: String(err.cause),
    },
  });
}
