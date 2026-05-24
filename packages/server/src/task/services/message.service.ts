import type { Db } from "../../db/client.js";
import type { Message, Part } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import type {
  AppId,
  ConversationId,
  MessageId,
  TmDecision,
} from "@moltzap/protocol/task";
import {
  MessageSendPermission,
  validateTmDecision,
} from "@moltzap/protocol/task";
import type { AppHost } from "../../app/app-host.js";
import {
  ConversationArchivedError,
  ForbiddenError,
  HookBlockedError,
  MessageReceivedNotificationDefinition,
  NotFoundError,
  TaskClosedError,
} from "@moltzap/protocol";
import {
  Cause,
  Duration,
  Effect,
  Fiber,
  Option,
  Schedule,
  Schema,
} from "effect";
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
import { opaquePayload } from "../../network/network-send.js";
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
import { sql } from "../../db/sql.js";
import type { MessageRow } from "../../db/database.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "../../db/effect-kysely-toolkit.js";
import type {
  ActiveKekRow,
  ConversationDek,
  ConversationKeyMaterialRow,
  EncryptedParts,
  ResolveSendVerdictInput,
  SendCommitInput,
  SendConversationRow,
  SendInsertInput,
  SendInsertResult,
  SendMessageInput,
} from "./message-service-types.js";

export type {
  SendInsertInput,
  SendInsertResult,
  SendMessageInput,
} from "./message-service-types.js";

/** Postgres returns bytea as Buffer, while PGlite returns Uint8Array. Normalize so .toString("utf-8") works. */
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

  /**
   * #560: AppHost owns the `messages/authorize` registry and runner.
   * Optional only because legacy unit-test stubs construct
   * MessageService without AppHost; production wiring (layers.ts)
   * always provides one. Calls on `null` short-circuit to the
   * synthetic Forward-all-participants default, matching the
   * pre-#560 broadcast.
   */
  readonly appHost: AppHost | null;
}

/**
 * `messages/send` server entry point. The `send` method runs the
 * structural checks against `(conversations ⋈ tasks)`, persists the
 * message, then resolves the TM verdict via the `messages/authorize`
 * round-trip and broadcasts per verdict.
 *
 * Branch over `task.status`:
 * - `{closed, failed}` → fail closed with `TaskClosed`; no insert.
 * - `{waiting, active}` → insert + `messages/authorize` verdict +
 *   verdict-scoped broadcast.
 *
 * The `messages/authorize` round-trip is the TM's gate: AppHost fails
 * closed (`Block { reason: "tm_unreachable" }`) on timeout, handler
 * error, or RPC failure. On Forward, `network.send` broadcasts to
 * `verdict.recipients`; on Block, the call fails with `HookBlocked`.
 *
 * `bypassTmRouting=true` skips the `messages/authorize` round-trip
 * and synthesizes a Forward-to-all-participants-except-sender verdict.
 * No wire handler currently sets this flag (every entry point hardcodes
 * `false`); it is retained as the internal extension point for
 * server-authored inserts whose authorization is already established
 * upstream.
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
  private readonly appHost: AppHost | null;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
    this.encryption = deps.encryption;
    this.deliveryWebhook = deps.deliveryWebhook;
    this.webhookClient = deps.webhookClient;
    this.appHost = deps.appHost;
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
   * CAS-guarded UPDATE of `messages.tm_decision` after the
   * `messages/authorize` gate resolves.
   *
   * Issue #560 inserts each row with `{tag: "pending"}` in {@link sendInsert};
   * this method transitions to `{tag: "forward", recipients}` or
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
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        // Kysely query-builder UPDATE with CAS predicate. Postgres sees:
        //   UPDATE messages
        //   SET tm_decision = $1
        //   WHERE id = $2
        //     AND tm_decision @> '{"tag":"pending"}'
        //   RETURNING id
        // Containment (`@>`) is parameter-safe (Postgres binds the JSON
        // value as a query parameter); the project's no-raw-SQL rule
        // is honoured. The row-count semantic is rowCount=1 iff the
        // row was still pending at UPDATE time; concurrent transitions
        // see committed=false and skip the dependent broadcast.
        const result = yield* Effect.tryPromise({
          try: () =>
            this.db
              .updateTable("messages")
              .set({ tm_decision: verdict })
              .where("id", "=", messageId)
              .where("tm_decision", "@>", JSON.stringify({ tag: "pending" }))
              .returning("id")
              .execute(),
          catch: (cause) =>
            new SqlError({ cause, message: "recordTmDecision UPDATE failed" }),
        });
        return { committed: result.length === 1 };
      }),
    );
  }

  sendInsert(
    input: SendInsertInput,
  ): Effect.Effect<
    SendInsertResult,
    MessageServiceError,
    MessageSendPermission
  > {
    return catchSqlErrorAsDefect(this.sendInsertEffect(input));
  }

  private sendInsertEffect(
    input: SendInsertInput,
  ): Effect.Effect<
    SendInsertResult,
    MessageServiceError | SqlError | Cause.NoSuchElementException,
    MessageSendPermission
  > {
    return Effect.gen(this, function* () {
      const permission = yield* MessageSendPermission;
      // Defensive: handler-input <-> capability identity match.
      if (
        permission.conversationId !== input.conversationId ||
        permission.senderAgentId !== input.senderAgentId
      ) {
        return yield* Effect.fail(
          new ForbiddenError({
            message: "capability/message-send target mismatch",
          }),
        );
      }
      const conv = yield* this.readSendConversation(input.conversationId);
      const parts = [...input.parts];
      const encrypted = yield* this.encryptParts(input.conversationId, parts);
      const row = yield* this.insertMessageRow(input, conv, encrypted);
      return {
        message: this.mapMessage(row, parts),
        parts,
        conv,
        excludeConnectionId: input.excludeConnectionId,
        bypassTmRouting: input.bypassTmRouting,
      };
    });
  }

  /**
   * Send-conversation projection consumed by
   * `obtainMessageSendPermission` (composite capability) AND
   * `MessageService.sendCommit`'s `messages/authorize` verdict route.
   * Joins `conversations` ⋈ `tasks` and returns
   * `(archived_at, task_id, app_id, task_status)`.
   *
   * Pre-cutover the obtain helper also consulted `app_id` to decide
   * the TM-bypass branch (caller IS the registered remote-app
   * connection ⇒ skip `refineTaskActive`). That branch was removed in
   * the #673 follow-up; the `app_id` column stays because the
   * verdict-routing consumer still reads it.
   * @internal
   */
  readSendConversation(
    conversationId: ConversationId,
  ): Effect.Effect<
    SendConversationRow,
    SqlError | Cause.NoSuchElementException
  > {
    return takeFirstOrFail(
      this.db
        .selectFrom("conversations as c")
        .innerJoin("tasks as t", "t.id", "c.task_id")
        .select([
          "c.archived_at",
          "c.task_id",
          "t.app_id as app_id",
          "t.status as task_status",
        ])
        .where("c.id", "=", conversationId),
    );
  }

  /**
   * Reply-target presence gate consumed by `obtainValidReplyTarget`
   * (Spec E #601). Kept as a method because it needs `this.db`.
   * @internal
   */
  assertReplyTarget(
    conversationId: ConversationId,
    replyToId: MessageId,
  ): Effect.Effect<void, NotFoundError | SqlError> {
    return Effect.gen(this, function* () {
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
    });
  }

  private insertMessageRow(
    input: SendInsertInput,
    conv: SendConversationRow,
    encryptedParts: EncryptedParts,
  ): Effect.Effect<MessageRow, SqlError> {
    const messageIdValue = crypto.randomUUID() as MessageId;
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
            reply_to_id: input.replyToId ?? null,
            parts_encrypted: encryptedParts.encrypted,
            parts_iv: encryptedParts.iv,
            parts_tag: encryptedParts.tag,
            dek_version: encryptedParts.dekVersion,
            kek_version: encryptedParts.kekVersion,
            task_id: conv.task_id,
            created_at: new Date(createdAtIso),
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      catch: (cause) =>
        new SqlError({ cause, message: "insert messages failed" }),
    });
  }

  /**
   * TM routing, broadcast, trace, and delivery webhook tail.
   *
   * Issue #529 sequencing preserves the pre-split order from architect plan §9
   * risk #9: TM route -> preview -> fan-out -> trace -> webhook.
   *
   * #560 cutover — the unconditional broadcast is replaced by the
   * `messages/authorize` gate:
   *   1. Resolve TM verdict via `appHost.runMessageAuthorize`.
   *   2. CAS-guarded `recordTmDecision` writes the verdict to
   *      `messages.tm_decision`; loser of the race no-ops.
   *   3. (winner only) On Block, fail closed with `HookBlockedError`.
   *      On Forward, broadcast to `verdict.recipients` (not all
   *      participants).
   *
   * `bypassTmRouting=true` skips the gate: the caller has already
   * established authorization upstream, so the server records a
   * synthetic `Forward { participants \ sender }` verdict and
   * broadcasts as usual. No wire handler currently sets the flag;
   * it is the internal extension point for server-authored inserts.
   * Participant fan-out is best-effort after the durable insert. Offline
   * participants are not a send failure: `broadcast` reports which agent IDs
   * were reached, `recordTrace` and `deliveryWebhook` observe the misses, and
   * reconnecting clients recover durable history via `messages/list`.
   */
  sendCommit(
    carrier: SendInsertResult,
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<Message, MessageServiceError> {
    return catchSqlErrorAsDefect(
      this.sendCommitEffect({ carrier, conversationId, senderAgentId }),
    );
  }

  private sendCommitEffect(
    input: SendCommitInput,
  ): Effect.Effect<Message, MessageServiceError | SqlError> {
    return Effect.gen(this, function* () {
      this.updatePreview(input);

      const verdict = yield* this.resolveCommitVerdict(input);
      const effectiveVerdict = yield* this.commitTmDecision(
        input.carrier.message.id,
        verdict,
      );
      yield* this.failBlockedVerdict(input, effectiveVerdict);

      const recipientList = recipientsFromVerdict(effectiveVerdict);
      const delivered = yield* this.broadcastCommittedMessage(
        input,
        recipientList,
      );
      yield* this.recordTrace(input, recipientList, delivered);
      this.spawnDeliveryWebhooks(input, recipientList, delivered);
      yield* this.logMessageSent(input);
      return input.carrier.message;
    });
  }

  private updatePreview(input: SendCommitInput): void {
    const firstTextPart = input.carrier.parts.find(
      (part) => part.type === "text",
    );
    if (firstTextPart?.type !== "text") return;
    this.conversations.updatePreviewCache(
      input.conversationId,
      firstTextPart.text,
    );
  }

  private resolveCommitVerdict(
    input: SendCommitInput,
  ): Effect.Effect<TmDecision, never> {
    if (input.carrier.bypassTmRouting) {
      return this.defaultForwardVerdict(input);
    }
    return this.resolveSendVerdict({
      messageId: input.carrier.message.id,
      // Boundary cast: SendConversationRow.app_id arrives as the raw
      // Kysely `string`; brand at the consumer call site.
      appId: input.carrier.conv.app_id as AppId,
      conversationId: input.conversationId,
      senderAgentId: input.senderAgentId,
      parts: input.carrier.parts,
      taskId: input.carrier.conv.task_id,
    });
  }

  private defaultForwardVerdict(
    input: SendCommitInput,
  ): Effect.Effect<TmDecision, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const participants = yield* this.conversations.getParticipantAgentIds(
          input.conversationId,
        );
        return {
          tag: "forward" as const,
          recipients: participants.filter((id) => id !== input.senderAgentId),
        };
      }),
    );
  }

  private commitTmDecision(
    messageId: MessageId,
    verdict: TmDecision,
  ): Effect.Effect<TmDecision, never> {
    return Effect.gen(this, function* () {
      const { committed } = yield* this.recordTmDecision(messageId, verdict);
      if (committed) return verdict;
      return yield* this.readTmDecision(messageId);
    });
  }

  private failBlockedVerdict(
    input: SendCommitInput,
    verdict: TmDecision,
  ): Effect.Effect<void, HookBlockedError> {
    if (verdict.tag !== "block") return Effect.void;
    const reason = verdict.reason ?? "blocked";
    const error = new HookBlockedError({
      message: "Message blocked by task manager",
      data: { reason, messageId: input.carrier.message.id },
    });
    return this.recordBlockedTrace(input, reason).pipe(
      Effect.zipRight(Effect.fail(error)),
    );
  }

  private broadcastCommittedMessage(
    input: SendCommitInput,
    recipientList: readonly AgentId[],
  ): Effect.Effect<readonly AgentId[], never> {
    const event = MessageReceivedNotificationDefinition.encode({
      taskId: input.carrier.conv.task_id,
      message: input.carrier.message,
    });
    const audience = Array.from(
      new Set([...recipientList, input.senderAgentId]),
    ) as AgentId[];
    return this.networkSendService
      .broadcast(audience, opaquePayload(JSON.stringify(event)), {
        forConversation: input.conversationId,
        excludeConnectionId: input.carrier.excludeConnectionId,
        messageId: input.carrier.message.id,
      })
      .pipe(Effect.map((result) => result.delivered as readonly AgentId[]));
  }

  private recordTrace(
    input: SendCommitInput,
    recipientList: readonly AgentId[],
    delivered: readonly AgentId[],
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
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
    });
  }

  private recordBlockedTrace(
    input: SendCommitInput,
    reason: string,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const traceMetadata = yield* this.getTraceMessageMetadata(
        input.conversationId,
        input.senderAgentId,
      );
      const { textPartCount, textLength } = textPartsMetadata(
        input.carrier.parts,
      );
      yield* Effect.void.pipe(
        Effect.withSpan("moltzap.message.blocked", {
          attributes: {
            "moltzap.hook.name": "before_message_delivery",
            "moltzap.message.id": input.carrier.message.id,
            "moltzap.message.conversation_id": input.conversationId,
            "moltzap.message.sender_id": input.senderAgentId,
            "moltzap.message.created_at": input.carrier.message.createdAt,
            "moltzap.message.part_count": input.carrier.parts.length,
            "moltzap.message.text_part_count": textPartCount,
            "moltzap.message.text_length": textLength,
            "moltzap.channel.key": traceMetadata.channelKey,
            "moltzap.sender.display_name": traceMetadata.senderDisplayName,
            "moltzap.block.reason": reason,
          },
        }),
      );
    });
  }

  private spawnDeliveryWebhooks(
    input: SendCommitInput,
    recipientList: readonly AgentId[],
    delivered: readonly AgentId[],
  ): void {
    if (this.deliveryWebhook === null || this.webhookClient === null) return;
    const deliveredSet = new Set(delivered);
    const offlineRecipientAgentIds = recipientList.filter(
      (id) => id !== input.senderAgentId && !deliveredSet.has(id),
    ) as AgentId[];
    if (offlineRecipientAgentIds.length === 0) return;
    this.spawnDeliveryWebhook({
      conversationId: input.conversationId,
      messageId: input.carrier.message.id,
      offlineRecipientAgentIds,
    });
  }

  private logMessageSent(input: SendCommitInput): Effect.Effect<void> {
    return Effect.logInfo("Message sent").pipe(
      Effect.annotateLogs({
        conversationId: input.conversationId,
        messageId: input.carrier.message.id,
      }),
    );
  }

  /**
   * Run the `messages/authorize` gate via AppHost and translate the
   * verdict into the `TmDecision` shape persisted on
   * `messages.tm_decision`. AppHost fails closed (`Block { reason:
   * "tm_unreachable" }`) on timeout / handler error / RPC failure;
   * this method never errors.
   */
  private resolveSendVerdict(
    input: ResolveSendVerdictInput,
  ): Effect.Effect<TmDecision, never> {
    const host = this.appHost;
    if (!host) {
      // Legacy / unit-test path with no AppHost wired. Fall back to
      // the synthetic Forward-all-participants verdict.
      return catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          const participants = yield* this.conversations.getParticipantAgentIds(
            input.conversationId,
          );
          return {
            tag: "forward" as const,
            recipients: participants.filter((id) => id !== input.senderAgentId),
          };
        }),
      );
    }
    return Effect.gen(this, function* () {
      const result = yield* host.runMessageAuthorize(input.appId, {
        conversationId: input.conversationId,
        message: {
          id: input.messageId,
          senderAgentId: input.senderAgentId,
          parts: [...input.parts],
        },
        taskId: input.taskId,
        appId: input.appId,
      });
      switch (result.decision) {
        case "Forward":
          return {
            tag: "forward" as const,
            recipients: [...result.recipients],
          };
        case "Block":
          return {
            tag: "block" as const,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          };
        default: {
          const _absurd: never = result;
          return _absurd;
        }
      }
    });
  }

  /**
   * Race-loser path: re-read `tm_decision` after CAS UPDATE fails
   * (committed=false). The winner has already committed; this returns
   * the current persisted state so the loser mirrors the winner's
   * outcome on the wire.
   */
  private readTmDecision(
    messageId: MessageId,
  ): Effect.Effect<TmDecision, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("messages")
            .select("tm_decision")
            .where("id", "=", messageId),
        );
        if (Option.isNone(rowOpt)) {
          // Shouldn't happen — the row is durably inserted before
          // sendCommit. Treat as Block for fail-closed posture.
          return { tag: "block" as const, reason: "row_missing" };
        }
        // tm_decision is `Generated<Json>`; protocol owns the schema.
        return yield* decodeTmDecision(rowOpt.value.tm_decision);
      }),
    );
  }

  send(
    input: SendMessageInput,
  ): Effect.Effect<Message, MessageServiceError, MessageSendPermission> {
    return Effect.gen(this, function* () {
      const bypassTmRouting = input.bypassTmRouting ?? false;
      const carrier = yield* this.sendInsert({
        ...input,
        bypassTmRouting,
      });
      return yield* this.sendCommit(
        carrier,
        input.conversationId,
        input.senderAgentId,
      );
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
        body: null,
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
    callerConnId: ConnectionId,
    options: {
      limit?: number;
      sinceSeq?: string;
    } = {},
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.conversations.assertConversationParticipant(
          conversationId,
          requesterAgentId,
        );
        const limit = Math.min(
          options.limit ?? DEFAULT_MESSAGE_HISTORY_LIMIT,
          MAX_MESSAGE_HISTORY_LIMIT,
        );
        const rows = yield* this.visibleMessageRows({
          conversationId,
          requesterAgentId,
          callerConnId,
          sinceSeq: options.sinceSeq,
          limit,
        });
        const hasMore = rows.length > limit;
        const resultRows = hasMore ? rows.slice(0, limit) : rows;
        const messages = yield* this.messageRowsToMessages(resultRows);
        return { messages, hasMore };
      }),
    );
  }

  private visibleMessageRows(args: {
    readonly conversationId: ConversationId;
    readonly requesterAgentId: AgentId;
    readonly callerConnId: ConnectionId;
    readonly sinceSeq: string | undefined;
    readonly limit: number;
  }): Effect.Effect<ReadonlyArray<MessageRow>, SqlError> {
    const { conversationId, requesterAgentId, callerConnId, sinceSeq, limit } =
      args;
    return Effect.gen(this, function* () {
      const isTmCaller = yield* this.isTmForAppBoundTask(
        conversationId,
        callerConnId,
      );
      let qb = this.db
        .selectFrom("messages")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("is_deleted", "=", false);
      if (sinceSeq !== undefined) {
        qb = qb.where("seq", ">", sinceSeq);
      }
      if (!isTmCaller) {
        qb = qb.where((eb) =>
          eb.or([
            eb("sender_id", "=", requesterAgentId),
            eb.and([
              eb("tm_decision", "@>", JSON.stringify({ tag: "forward" })),
              eb(
                "tm_decision",
                "@>",
                JSON.stringify({ recipients: [requesterAgentId] }),
              ),
            ]),
          ]),
        );
      }
      return yield* qb.orderBy("seq", "desc").limit(limit + 1);
    });
  }

  private messageRowsToMessages(
    rows: ReadonlyArray<MessageRow>,
  ): Effect.Effect<Message[], never> {
    return Effect.gen(this, function* () {
      const dekCache = new Map<number, Buffer>();
      const messages: Message[] = [];
      for (const row of rows) {
        const parts = yield* this.decryptPartsWithCache(row, dekCache);
        messages.push(this.mapMessage(row, parts));
      }
      messages.reverse();
      return messages;
    });
  }

  /**
   * Visibility helper that returns true iff the caller's WS
   * connection IS the registered remote-app connection for the
   * conversation's bound app (#673 app-ownership gate). Tasks whose
   * caller is not the app moderator see the filtered-by-tm_decision
   * view; the moderator sees every row.
   */
  private isTmForAppBoundTask(
    conversationId: ConversationId,
    callerConnId: ConnectionId,
  ): Effect.Effect<boolean, never> {
    const host = this.appHost;
    if (host === null) return Effect.succeed(false);
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations as c")
            .innerJoin("tasks as t", "t.id", "c.task_id")
            .select(["t.app_id"])
            .where("c.id", "=", conversationId),
        );
        if (Option.isNone(rowOpt)) return false;
        // Boundary cast: Kysely returns `app_id` as `string`; the brand
        // boundary is the type system, not a format check.
        return host.isAppConnection(rowOpt.value.app_id as AppId, callerConnId);
      }),
    );
  }

  private encryptParts(
    conversationId: ConversationId,
    parts: Part[],
  ): Effect.Effect<EncryptedParts, never> {
    const encryption = this.encryption;
    if (encryption === null) {
      return Effect.succeed(plaintextEncryptedParts(parts));
    }
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
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
      }),
    );
  }

  private getOrCreateConversationDek(
    conversationId: ConversationId,
    encryption: EnvelopeEncryption,
  ): Effect.Effect<
    ConversationDek,
    SqlError | Cause.NoSuchElementException,
    never
  > {
    return Effect.gen(this, function* () {
      const keyRowOpt = yield* this.readLatestConversationKey(conversationId);
      if (Option.isSome(keyRowOpt)) {
        return unwrapConversationDek(encryption, keyRowOpt.value);
      }
      return yield* this.createConversationDek(conversationId, encryption);
    });
  }

  private readLatestConversationKey(
    conversationId: ConversationId,
  ): Effect.Effect<Option.Option<ConversationKeyMaterialRow>, SqlError, never> {
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
  ): Effect.Effect<
    ConversationDek,
    SqlError | Cause.NoSuchElementException,
    never
  > {
    return Effect.gen(this, function* () {
      const newDek = generateDek();
      const kekRow = yield* this.activeKekRow();
      const kek = encryption.decryptKek(
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
        return { dek: newDek, dekVersion: 1, kekVersion: kekRow.version };
      }
      return yield* this.readWinningConversationDek(conversationId, encryption);
    });
  }

  private activeKekRow(): Effect.Effect<ActiveKekRow, SqlError, never> {
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
  ): Effect.Effect<
    ConversationDek,
    SqlError | Cause.NoSuchElementException,
    never
  > {
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

function recipientsFromVerdict(verdict: TmDecision): readonly AgentId[] {
  if (verdict.tag !== "forward") return [];
  return verdict.recipients as readonly AgentId[];
}

function plaintextEncryptedParts(parts: ReadonlyArray<Part>): EncryptedParts {
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
    dek: unwrapKey(deserializePayload(row.wrapped_dek), kek),
    dekVersion: row.dek_version,
    kekVersion: row.kek_version,
  };
}

function decodeTmDecision(raw: unknown): Effect.Effect<TmDecision> {
  if (validateTmDecision(raw)) return Effect.succeed(raw);
  return Effect.die(`malformed tm_decision: ${JSON.stringify(raw)}`);
}
