import type { Db } from "../db/client.js";
import type { Message, Part, TaskStatus } from "@moltzap/protocol";
import {
  ErrorCodes,
  MessageReceivedNotificationDefinition,
  agentId as protocolAgentId,
  conversationId as protocolConversationId,
  messageId as protocolMessageId,
  notificationFrame,
} from "@moltzap/protocol";
import {
  isEndpointAddress,
  type EndpointAddress,
} from "@moltzap/protocol/network";
import { Duration, Effect, Fiber, Option, Schedule, Schema } from "effect";
import { SqlError } from "@effect/sql/SqlError";
import { RpcFailure, notFound, internalError } from "../runtime/index.js";
import { nextSnowflakeId } from "../db/snowflake.js";
import type { ConversationService } from "./conversation.service.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { NetworkSendService } from "../network/network-send.js";
import {
  opaquePayload,
  RecipientNotResolved,
  WriteFailed,
} from "../network/network-send.js";
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

/**
 * Phase 9b consumer-migration (sub-issue #460, plan §2.4.a + §10.1 +
 * §1.3): `messages/send` is the wire entry point that runs three
 * structural checks against `(conversations ⋈ tasks)`, persists the
 * message, then dispatches to the task's registered TM via
 * `network.send` per the §1.3 in-process loopback policy ("ALWAYS
 * through `network.send` — no short-circuit").
 *
 * Order (round 4 R17 — codex HIGH-B): DB insert FIRST, then
 * `network.send`. Pre-R17 the order was reversed; if the insert failed
 * (unique violation, encryption error, connection drop) the TM had
 * already received a `messages/received` frame for a `messageId` that
 * never landed in the server-of-truth. R17 swaps the order so the TM
 * only ever observes message ids the DB committed.
 *
 * Branch table (exhaustive over `(task.status)` post round 3 R12 +
 * round 4 R17):
 *
 *   `task.status ∈ {closed, failed}` → fail closed: TaskClosed (codex
 *                                       HIGH-3); insert short-circuits.
 *   `task.status ∈ {waiting, active}` → insert + broadcast. After the
 *                                       insert lands, fire-and-forget
 *                                       `network.send` to the TM.
 *                                       DeliveryError lifts to
 *                                       `RpcFailure(HookBlocked)` (TM
 *                                       offline / write failed).
 *
 * The pre-R12 branches for `task_id IS NULL` (non-task conversation)
 * and `tm_endpoint_address IS NULL` (task without registered TM)
 * retired with the schema NOT NULL constraints; the INNER JOIN below
 * makes them structurally unreachable.
 *
 * Phase 9b scope boundary: `network.send` is one-way per §1.3. The TM
 * observes the message and acts via CRUD (e.g., `tasks/storeMessage`);
 * the `block/patch/feedback` admission shape (deleted
 * `apps/onBeforeMessageDelivery`) does NOT round-trip through
 * `network.send`. Phase 11 (arena cutover) is the natural seam to
 * introduce an awaitable TM-side verdict RPC. Today the failure
 * channel covers only delivery liveness (TM unreachable) plus the
 * `TaskClosed` structural gate — not application-level denial.
 *
 * The `bypassTmRouting` flag exists for the TM-authored insert path:
 * `tasks/storeMessage` calls `MessageService.send` from the TM's own
 * connection, and without the flag the resulting `messages/received`
 * frame would route via `network.send` back to the TM's own socket
 * (self-loop on every TM-authored insert; codex HIGH-1).
 */
export class MessageService {
  private deliveryWebhookFibers = new Set<
    Fiber.RuntimeFiber<unknown, unknown>
  >();

  constructor(
    private db: Db,
    private conversations: ConversationService,
    private broadcaster: Broadcaster,
    private networkSendService: NetworkSendService,
    private encryption: EnvelopeEncryption | null,
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
    /**
     * When `true`, skip the entire TM-routing branch (lookup, fail-closed
     * checks, `network.send` dispatch). The TM-authored insert path
     * (`tasks/storeMessage`) sets this so a TM calling its own CRUD does
     * not re-emit a `MessageReceivedNotification` frame back to itself
     * via `network.send` — that would self-loop on every TM-authored
     * insert (codex HIGH-1).
     */
    bypassTmRouting = false,
  ): Effect.Effect<Message, RpcFailure> {
    // Phase 9b consumer-migration (sub-issue #460, plan §2.4): the
    // `dispatchLeaseId` parameter retired alongside the
    // `apps/onBeforeMessageDelivery` hook that consumed it. The wire
    // schema at `packages/protocol/src/task/methods/messages.ts` keeps
    // `dispatchLeaseId` as an optional field (Phase 11 arena cutover
    // will retire the field once arena's channel runtime stops minting
    // it); the server-side `MessageService.send` no longer threads it.
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const parts = inputParts;
        yield* this.conversations.requireParticipant(
          conversationId,
          senderAgentId,
        );

        // Phase 9b consumer-migration (sub-issue #460 round 3 R12 +
        // round 4 R20): INNER JOIN on `conversations` ⋈ `tasks` is
        // structurally total — every conversation has `task_id` NOT
        // NULL and the FK to `tasks(id)` guarantees a row. The
        // `requireParticipant` gate above already rejected when the
        // conversation does not exist (no participant rows ⇒ FK to a
        // missing conversation can't form). The remaining shape is
        // "row exists" with a defined `task_status` and
        // `tm_endpoint_address`; `takeFirstOrFail` enforces totality
        // at the kysely seam so callers don't read through a vacuous
        // `Option.isSome` guard.
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

        // Phase 9b round 4 R17 (codex HIGH-B): the closed-task gate
        // runs BEFORE the DB insert so a closed task short-circuits
        // without a partial write. `task.status ∈ {closed, failed}`
        // surfaces as `TaskClosed`; only the `{waiting, active}`
        // branch falls through to insert + dispatch.
        if (!bypassTmRouting && !taskStatusAcceptsMessages(conv.task_status)) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.TaskClosed,
              message: `Task is ${conv.task_status}`,
              data: {
                reason: "TaskClosed",
                taskId: conv.task_id,
                status: conv.task_status,
              },
            }),
          );
        }

        // Mint the message id here so the eventual DB row + the TM
        // frame (dispatched after the insert lands) agree on `id`.
        // `seq` is a server-internal monotonic ordering token, not
        // part of the wire `Message` shape.
        const seq = nextSnowflakeId();
        const messageIdValue = crypto.randomUUID();
        const createdAtIso = new Date().toISOString();

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
                // Issue #465: stamp at insert time so cross-task
                // queries can filter by `task_id` without joining
                // through `conversations`. Replaces the post-insert
                // UPDATE that `tasks/storeMessage` used to issue.
                task_id: conv.task_id,
                // Persist the server-minted ISO timestamp so every
                // downstream view (mapped Message, broadcaster frame,
                // TM frame dispatched after the insert) agrees on
                // `createdAt`. Without an explicit value here Postgres
                // would default to its own `now()`, drifting from the
                // wire `Message.createdAt`.
                created_at: new Date(createdAtIso),
              })
              .returningAll()
              .executeTakeFirstOrThrow(),
          catch: (cause) =>
            new SqlError({ cause, message: "insert messages failed" }),
        });

        const message = this.mapMessage(row, parts);

        // Phase 9b round 4 R17 (codex HIGH-B): fire the TM-routed
        // frame ONLY after the DB insert lands. Pre-R17 the order
        // was reversed — if the insert failed (unique violation,
        // encryption error, connection drop), the TM had already
        // observed a `messages/received` frame for a `messageId`
        // that never landed in the server-of-truth. Post-R17 the TM
        // only observes ids the DB committed.
        if (!bypassTmRouting) {
          const tmAddr = yield* decodeTmEndpointAddress(
            conv.tm_endpoint_address,
          );
          const tmFrame = notificationFrame(
            MessageReceivedNotificationDefinition,
            { message },
          );
          yield* this.networkSendService
            .send(tmAddr, opaquePayload(JSON.stringify(tmFrame)))
            .pipe(Effect.mapError(deliveryErrorToRpcFailure));
        }

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

        // Participants drive trace capture's recipient list and the
        // delivery-webhook's offline-recipient set below.
        const participants =
          yield* this.conversations.getParticipantAgentIds(conversationId);

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
        // fiber so the `send` RPC returns immediately. `delivered` is the
        // presence signal — every participant not in that set is treated
        // as offline for the webhook fanout.
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

  private mapMessage(row: MessageRow, parts: Part[]): Message {
    return {
      id: protocolMessageId(row.id),
      conversationId: protocolConversationId(row.conversation_id),
      senderId: protocolAgentId(row.sender_id),
      replyToId:
        row.reply_to_id === null
          ? undefined
          : protocolMessageId(row.reply_to_id),
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

/**
 * Decode the raw `tasks.tm_endpoint_address` column (NOT NULL post
 * round 3 R12) into a branded `EndpointAddress`. A malformed non-null
 * row is data corruption and surfaces as `RpcFailure(InternalError)`
 * so the TM gate fails closed instead of silently mis-routing.
 */
function decodeTmEndpointAddress(
  raw: string,
): Effect.Effect<EndpointAddress, RpcFailure> {
  if (isEndpointAddress(raw)) return Effect.succeed(raw);
  return Effect.fail(
    internalError(`Malformed tm_endpoint_address in tasks row: ${raw}`),
  );
}

/**
 * Translate a `network.send` `DeliveryError` into a `messages/send`
 * `RpcFailure`. Phase 9b consumer-migration (sub-issue #460): replaces
 * the `apps/onBeforeMessageDelivery → block: true → HookBlocked` pathway.
 * Both `RecipientNotResolved` and `WriteFailed` map to `HookBlocked`
 * (recoverable: TM is offline or its socket failed).
 */
function deliveryErrorToRpcFailure(
  err: RecipientNotResolved | WriteFailed,
): RpcFailure {
  if (err instanceof RecipientNotResolved) {
    return new RpcFailure({
      code: ErrorCodes.HookBlocked,
      message: "Task manager is not reachable",
      data: { reason: "RecipientNotResolved", to: String(err.to) },
    });
  }
  return new RpcFailure({
    code: ErrorCodes.HookBlocked,
    message: "Task manager dispatch failed",
    data: {
      reason: "WriteFailed",
      to: String(err.to),
      cause: String(err.cause),
    },
  });
}
