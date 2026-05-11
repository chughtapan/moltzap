import type { Db } from "../../db/client.js";
import type { Message, Part, TaskStatus } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type {
  ConversationId,
  MessageId,
  TaskId,
  TmDecision,
} from "@moltzap/protocol/task";
import type { AppHost } from "../../app/app-host.js";

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
import {
  Duration,
  Effect,
  Fiber,
  HashSet,
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
import {
  opaquePayload,
  RecipientNotResolved,
  WriteFailed,
} from "../../network/network-send.js";
import type { AgentEndpointResolver } from "../../network/agent-endpoint-resolver.js";
import { makeEndpointAddress } from "@moltzap/protocol/network";
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
  /**
   * #463 v3: synchronous in-memory resolver used by {@link
   * MessageService.preflightRecipients} to fail-close BEFORE the
   * durable INSERT in `send()` when a recipient has no live socket.
   * Same instance the `NetworkSendService` consumes — the resolver is
   * a process-local `Ref`-backed multimap, so two views agree.
   */
  readonly resolver: AgentEndpointResolver;
  readonly encryption: EnvelopeEncryption | null;
  readonly deliveryWebhook: DeliveryWebhookConfig | null;
  readonly webhookClient: WebhookClient | null;
  readonly traceCapture: TraceCapture | null;
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
  private readonly resolver: AgentEndpointResolver;
  private readonly encryption: EnvelopeEncryption | null;
  private readonly deliveryWebhook: DeliveryWebhookConfig | null;
  private readonly webhookClient: WebhookClient | null;
  private readonly traceCapture: TraceCapture | null;
  private readonly appHost: AppHost | null;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
    this.resolver = deps.resolver;
    this.encryption = deps.encryption;
    this.deliveryWebhook = deps.deliveryWebhook;
    this.webhookClient = deps.webhookClient;
    this.traceCapture = deps.traceCapture;
    this.appHost = deps.appHost;
  }

  close(): Effect.Effect<void, never> {
    const pending = [...this.deliveryWebhookFibers];
    this.deliveryWebhookFibers.clear();
    return pending.length > 0 ? Fiber.interruptAll(pending) : Effect.void;
  }

  /**
   * #463 v3 — synchronous resolver pre-check that runs BEFORE the
   * durable INSERT in {@link send}. Resolves each conversation
   * participant (excluding the sender) through {@link
   * AgentEndpointResolver.resolveAll}; fails closed with {@link
   * RecipientNotResolved} as soon as one required recipient has no
   * live connection. On success returns the resolved recipient set so
   * the caller does not have to re-walk the participant list.
   *
   * Architect plan §1 (v3): v2 attempted to catch broadcast-side
   * failures POST-INSERT via a `broadcast_attempted_at` column + CAS.
   * v3 simplifies: the only recoverable failure mode at fan-out time
   * is {@link RecipientNotResolved} (synchronous lookup miss). Pulling
   * that check PRE-INSERT shrinks the post-INSERT residual to {@link
   * WriteFailed} (mid-frame WS errors — rare), which is observable
   * via a structured log line and recoverable via the existing
   * `messages/list` pull channel. No DB column, no CAS, no idempotency
   * gate required.
   *
   * Architect plan §9 risk R1 (TOCTOU): a recipient may disconnect in
   * the microsecond gap between this preflight and the {@link
   * NetworkSendService.broadcast} fan-out; that is documented as the
   * {@link WriteFailed} residual. Mitigation: recipient pulls via
   * `messages/list` on reconnect; same recovery channel as before,
   * just a narrower window.
   *
   * The error channel is {@link RecipientNotResolved}. The handler
   * maps it to the RPC-visible `HookBlocked(RecipientNotResolved)`
   * shape via the existing `deliveryErrorToHookBlocked` helper, so the
   * wire surface is unchanged from the post-INSERT failure mode.
   */
  preflightRecipients(
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<
    { readonly recipients: ReadonlyArray<AgentId> },
    RecipientNotResolved
  > {
    return Effect.gen(this, function* () {
      const participants =
        yield* this.conversations.getParticipantAgentIds(conversationId);
      const recipients = participants.filter((id) => id !== senderAgentId);
      for (const recipient of recipients) {
        const conns = yield* this.resolver.resolveAll(recipient);
        if (HashSet.size(conns) === 0) {
          return yield* Effect.fail(
            new RecipientNotResolved({
              to: makeEndpointAddress("agent", recipient),
            }),
          );
        }
      }
      return { recipients };
    });
  }

  /**
   * #529 reshape additive — the durable insert subset of `send`.
   * Returns a `SendInsertResult` carrier that {@link sendCommit}
   * consumes for the routing/broadcast/trace tail. `send` composes both
   * for backward compatibility with all existing callers.
   *
   * Architect plan §3 carrier shape: `{ message, parts, conv,
   * excludeConnectionId, bypassTmRouting }`.
   *
   * #463 v3 integration point: `send()` (the top-level composer) calls
   * {@link preflightRecipients} BEFORE this method's INSERT runs.
   * Fail-closed on {@link RecipientNotResolved} ensures the durable
   * row is never written when the broadcast fan-out is provably unable
   * to reach any recipient. `sendInsert` itself is unchanged — the
   * preflight is a sibling concern composed at `send()`-level so the
   * `tasks/storeMessage` re-entry path (which sets `bypassTmRouting`
   * and may not have live recipients yet) opts out by not running
   * preflight on that path.
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
   * plan §9 risk #9): TM route -> preview -> fan-out -> trace -> webhook.
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
   * `bypassTmRouting=true` (TM-authored insert via `tasks/storeMessage`)
   * skips the gate: the TM has already admitted the message; the
   * server records a synthetic `Forward { participants \ sender }`
   * verdict and broadcasts as usual.
   *
   * #463 v3 integration point: {@link preflightRecipients} runs in
   * `send()` BEFORE the INSERT in {@link sendInsert}, so by the time
   * `sendCommit` runs the participant set is provably resolvable. The
   * residual failure mode here is {@link WriteFailed} from
   * `networkSendService.broadcast` (mid-frame WS error after a
   * recipient disconnected in the microsecond gap since preflight).
   * Architect plan §2 names a structured log emission at the
   * `network.send` failure site as the observability bit; v3 drops
   * the column + CAS scaffolding (v2's `broadcast_attempted_at`) on
   * the grounds that the residual is rare, recipient-side recovery
   * via `messages/list` already exists, and the durable row is
   * unchanged either way. The {@link NetworkSendService.broadcast}
   * call below threads the `messageId` so the failure-site log line
   * carries `{ messageId, conversationId, connId, reason: "WriteFailed" }`.
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

        // Pre-#560 TM-routing notification: still fires for app-bound
        // TMs over the actor-model `network.send` transport so existing
        // liveness contracts (`tm:agent:<id>` offline -> HookBlocked)
        // hold while the messages/authorize gate fills the policy role.
        // Default-DM/group's AppTmRegistry handler is a no-op observer;
        // app-TMs and custom-TM agents observe the inbound frame here.
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
        const defaultRecipients = participants.filter(
          (id) => id !== senderAgentId,
        );

        // Resolve the per-message fan-out verdict.
        // bypassTmRouting=true: TM-authored insert, gate skipped, default
        //   Forward to all-participants-minus-sender.
        // bypassTmRouting=false: run messages/authorize through AppHost.
        //   When the AppHost handle is null (legacy stub paths), fall
        //   back to the default Forward shape.
        const verdict: TmDecision = bypassTmRouting
          ? {
              tag: "forward",
              recipients: defaultRecipients,
            }
          : yield* this.resolveSendVerdict(
              message.id,
              conv.tm_endpoint_address,
              conversationId,
              senderAgentId,
              parts,
              conv.task_id,
            );

        // CAS-guarded UPDATE: only one of {real verdict, timeout
        // synthesized Block} can commit. Loser no-ops and follows
        // the winner's verdict for the outbound RPC reply.
        const { committed } = yield* this.recordTmDecision(message.id, verdict);

        // Race-loser path: re-read the row to see what the winner
        // committed, then mirror that outcome. The window is tiny;
        // this branch fires only on overlapping timeout +
        // real-verdict races.
        const effectiveVerdict: TmDecision = committed
          ? verdict
          : yield* this.readTmDecision(message.id);

        if (effectiveVerdict.tag === "block") {
          // No broadcast. Sender receives RpcFailure(HookBlocked).
          // Recipients never observe a `messages/received` frame.
          return yield* Effect.fail(
            new HookBlockedError({
              message: "Message blocked by task manager",
              data: {
                reason: effectiveVerdict.reason ?? "blocked",
                messageId: message.id,
              },
            }),
          );
        }

        // Forward path: broadcast to verdict.recipients (subset of
        // participants the TM authorized).
        const recipientList: readonly AgentId[] =
          effectiveVerdict.tag === "forward"
            ? (effectiveVerdict.recipients as readonly AgentId[])
            : [];

        const event = MessageReceivedNotificationDefinition.encode({
          message,
        });
        const eventPayload = opaquePayload(JSON.stringify(event));

        // Include the sender so the sender's own connections (other
        // tabs / processes) see the echo; the existing
        // `excludeConnectionId` flag still elides the sending socket.
        const broadcastAudience: readonly AgentId[] = Array.from(
          new Set([...recipientList, senderAgentId]),
        ) as AgentId[];
        const broadcastResult = yield* this.networkSendService.broadcast(
          broadcastAudience,
          eventPayload,
          {
            forConversation: conversationId,
            excludeConnectionId,
            // #463 v3 — context for the structured log emitted inside
            // broadcast's per-connection WriteFailed catchAll. The
            // failure site previously logged `{ connId, cause }` only;
            // threading the messageId here lets operators correlate the
            // log line with the durable row (which IS in the DB —
            // preflight already proved the recipient was reachable, so
            // this branch fires only on TOCTOU disconnects).
            messageId: message.id,
          },
        );
        const delivered: readonly AgentId[] =
          broadcastResult.delivered as readonly AgentId[];

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
            recipientAgentIds: recipientList,
            deliveredAgentIds: delivered,
          });
        }

        if (this.deliveryWebhook && this.webhookClient) {
          const deliveredSet = new Set(delivered);
          const offlineRecipientAgentIds = recipientList.filter(
            (id) => id !== senderAgentId && !deliveredSet.has(id),
          ) as AgentId[];
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

  /**
   * Run the `messages/authorize` gate via AppHost and translate the
   * verdict into the `TmDecision` shape persisted on
   * `messages.tm_decision`. AppHost fails closed (`Block { reason:
   * "tm_unreachable" }`) on timeout / handler error / RPC failure;
   * this method never errors.
   */
  private resolveSendVerdict(
    messageId: MessageId,
    tmEndpointAddressRaw: string,
    conversationId: ConversationId,
    senderAgentId: AgentId,
    parts: ReadonlyArray<Part>,
    taskId: TaskId,
  ): Effect.Effect<TmDecision, never> {
    const host = this.appHost;
    if (!host) {
      // Legacy / unit-test path with no AppHost wired. Fall back to
      // the synthetic Forward-all-participants verdict.
      return catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          const participants =
            yield* this.conversations.getParticipantAgentIds(conversationId);
          return {
            tag: "forward" as const,
            recipients: participants.filter((id) => id !== senderAgentId),
          };
        }),
      );
    }
    return Effect.gen(this, function* () {
      const tmAddr = yield* decodeTmEndpointAddress(tmEndpointAddressRaw);
      const result = yield* host.runMessageAuthorize(tmAddr, {
        conversationId,
        message: {
          id: messageId,
          senderAgentId,
          parts: [...parts],
        },
        taskId,
        // appId carried for observability + future TM routing. App-
        // bound tasks fill this; default-DM/group leaves it empty.
        appId: "",
        signal: new AbortController().signal,
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
        // tm_decision is `Generated<Json>` (ColumnType<unknown,...>);
        // Principle 2: decode at the boundary.
        return yield* decodeTmDecision(rowOpt.value.tm_decision);
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
      // #463 v3 — fail-closed preflight BEFORE the durable INSERT so
      // a message row is never written when broadcast fan-out is
      // provably unable to reach any recipient. The `bypassTmRouting`
      // branch (TM-authored insert via `tasks/storeMessage`) opts out:
      // that path accepts that the durable row may exist without live
      // recipients (recipient pulls via `messages/list` on reconnect).
      if (!bypassTmRouting) {
        yield* this.preflightRecipients(conversationId, senderAgentId).pipe(
          Effect.mapError(deliveryErrorToHookBlocked),
        );
      }
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

        // #560 per-caller visibility filter:
        //   - TM caller (app-bound tasks only, app_id IS NOT NULL,
        //     caller's endpoint address == task.tm_endpoint_address):
        //     sees every row (pending/forward/block).
        //   - Non-TM caller: sees own outbound rows AND `forward` rows
        //     whose `recipients` contain the caller. `pending` is
        //     hidden from non-senders, `block` from non-senders.
        //
        // Default-DM/group tasks (app_id IS NULL) have no external TM
        // caller — `isTmCaller` returns false; all callers go through
        // the non-TM path (memory feedback_predicate_tautology_lesson:
        // the asymmetry is intentional, not a missing case).
        const isTmCaller = yield* this.isTmForAppBoundTask(
          conversationId,
          requesterAgentId,
        );

        let qb = this.db
          .selectFrom("messages")
          .selectAll()
          .where("conversation_id", "=", conversationId)
          .where("is_deleted", "=", false);
        if (options.sinceSeq !== undefined) {
          qb = qb.where("seq", ">", options.sinceSeq);
        }

        if (!isTmCaller) {
          // Postgres `tm_decision @> $1` JSONB containment — parameter-
          // safe (no SQL string interpolation per memory
          // `feedback_no_raw_sql`). Two `@>` predicates AND-ed: the
          // verdict has tag=forward AND recipients contains caller.
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

  /**
   * #560 visibility helper: true iff the caller IS the registered TM
   * for an app-bound task. The shape of the check (mirrors
   * `requireConversationAdminAuthority`'s second branch):
   *
   *   task.app_id IS NOT NULL
   *   AND task.tm_endpoint_address === `tm:agent:<callerAgentId>`
   *
   * For default-DM/group tasks (app_id IS NULL) returns false — there
   * is no external caller to authenticate; the default-DM/group
   * messageAuthorize hook fires server-internally. The asymmetry is
   * intentional per architect plan §1 + R10.
   */
  private isTmForAppBoundTask(
    conversationId: ConversationId,
    callerAgentId: AgentId,
  ): Effect.Effect<boolean, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations as c")
            .innerJoin("tasks as t", "t.id", "c.task_id")
            .select(["t.app_id", "t.tm_endpoint_address"])
            .where("c.id", "=", conversationId),
        );
        if (Option.isNone(rowOpt)) return false;
        const row = rowOpt.value;
        if (row.app_id === null) return false;
        // The canonical wire shape is "tm:agent:<agentId>"; compare
        // direct-string-equality.
        return row.tm_endpoint_address === `tm:agent:${callerAgentId}`;
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

/**
 * Decode the raw `tm_decision` JSONB column (type `unknown` per the
 * boundary `Json` alias) into a typed `TmDecision`. The runtime check
 * is shape-only (the wire/DB schema is the canonical decoder; here we
 * narrow without importing the schema decoder to avoid a circular
 * dependency on `@moltzap/protocol`'s schema layer at MessageService).
 *
 * Malformed JSON (the column is NOT NULL with a `pending` default; a
 * corrupted value indicates external tampering) dies as a defect.
 */
function decodeTmDecision(raw: unknown): Effect.Effect<TmDecision> {
  if (raw && typeof raw === "object" && "tag" in raw) {
    const tag = (raw as { tag: unknown }).tag;
    if (tag === "pending") return Effect.succeed({ tag: "pending" });
    if (tag === "forward") {
      const recipients = (raw as { recipients?: unknown }).recipients;
      if (Array.isArray(recipients)) {
        return Effect.succeed({
          tag: "forward",
          recipients: recipients.filter(
            (a): a is AgentId => typeof a === "string",
          ),
        });
      }
    }
    if (tag === "block") {
      const reason = (raw as { reason?: unknown }).reason;
      return Effect.succeed({
        tag: "block",
        ...(typeof reason === "string" ? { reason } : {}),
      });
    }
  }
  return Effect.die(`malformed tm_decision: ${JSON.stringify(raw)}`);
}
