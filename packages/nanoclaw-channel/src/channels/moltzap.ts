/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Config, ConfigProvider, Data, Effect, Option, Schema } from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import { ConversationId } from "@moltzap/protocol/conversation";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import type { TaskId } from "@moltzap/protocol/task";
import {
  LeaseAlreadyConsumed,
  LeaseStore,
  MoltZapChannelCore,
  catchLeaseInvalid,
  formatCrossConv,
  formatGroupBlock,
  getGroupFields,
  type ChannelService,
  type EnrichedInboundMessage,
} from "@moltzap/client/channel-base";

// `MoltZapChannelError` covers nanoclaw's host-shape failures that are NOT
// lease-related (un-owned jid, missing taskId). Lease errors flow through
// channel-base's `LeaseAlreadyConsumed` instead.
class MoltZapChannelError extends Data.TaggedError("MoltZapChannelError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const EVAL_GROUP_NAME_ID_CHARS = 8;

import type { Channel, NewMessage } from "../types.js";
import { registerChannel, type ChannelOpts } from "./registry.js";

const MOLTZAP_JID_PREFIX = "mz:";
const MoltZapEvalModeEnv = Config.string("MOLTZAP_EVAL_MODE").pipe(
  Config.withDefault("0"),
);
const MoltZapChannelEnv = Config.all({
  profileName: Config.string("MOLTZAP_PROFILE"),
  evalMode: MoltZapEvalModeEnv,
});

/**
 * Bidirectional MoltZap conversationId ↔ nanoclaw JID conversion.
 *
 * The nanoclaw router speaks JIDs (`mz:&lt;conversationId>`). MoltZap
 * speaks conversationIds. The prefix is canonical; no provider
 * disambiguation needed because the moltzap channel is the only
 * `mz:` consumer.
 *
 * - `jidFromConversationId` runs on the inbound path
 *   (`MoltZapChannel.handleInbound`) and feeds the JID to the router
 *   via `opts.onChatMetadata` and `opts.onMessage`.
 * - `conversationIdFromJid` runs on the outbound path
 *   (`MoltZapChannel.sendMessage`) and strips the prefix back to a
 *   conversationId before the `messages/send` RPC.
 */
function jidFromConversationId(conversationId: string): string {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
}

function conversationIdFromJid(jid: string): ConversationId {
  return Schema.decodeUnknownSync(ConversationId)(
    jid.slice(MOLTZAP_JID_PREFIX.length),
  );
}

function loadMoltZapChannelEnv(): {
  readonly profileName: string;
  readonly evalMode: boolean;
} {
  const env = Effect.runSync(
    MoltZapChannelEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
  return {
    profileName: env.profileName,
    evalMode: env.evalMode === "1",
  };
}

function loadMoltZapEvalMode(): boolean {
  return (
    Effect.runSync(
      MoltZapEvalModeEnv.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ) === "1"
  );
}

/**
 * Nanoclaw channel for MoltZap. Wraps `MoltZapChannelCore` from
 * `@moltzap/client` and presents the nanoclaw `Channel` contract.
 * Bridges MoltZap's `EnrichedInboundMessage` shape onto nanoclaw's
 * `NewMessage` projection.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Core as MoltZapChannelCore (@moltzap/client)
 *   participant Handler as handleInbound (this class)
 *   participant Router as nanoclaw router
 *   Core->>Handler: onInbound(enriched)<br>WS frame decoded + enriched
 *   note over Handler: Step 1 — jidFromConversationId<br>chatJid = "mz:" + conversationId
 *   note over Handler: Step 2 — rememberDispatchLease<br>leaseStore.remember(chatJid, leaseId) if present
 *   note over Handler: Step 3 — maybeAutoRegister (eval mode only)
 *   Handler->>Router: Step 4 — opts.onChatMetadata({ chatJid, name, ... })<br>nanoclaw receives ChatMetadata BEFORE message
 *   Handler->>Router: Step 5 — opts.onMessage(chatJid, toNewMessage(enriched))
 * ```
 *
 * Lease-store stale-entry semantic: uses `peek` (not `consume`) so
 * a second `sendMessage` on the same JID after a consumed lease
 * receives the typed `LeaseAlreadyConsumed` from the server instead
 * of silently sending without a lease (delivery is server-enforced
 * single-use; the local entry is intentionally stale-after-consume).
 *
 * Connect / sendMessage / disconnect bridge:
 * - `connect()` runs `core.connect()` (Effect → Promise boundary
 *   here so the nanoclaw Channel interface stays Promise-shaped).
 * - `sendMessage(jid, text)` strips the `mz:` prefix back to a
 *   conversationId and calls `core.sendReply` with
 *   `catchLeaseInvalid` projecting `LeaseInvalid` wire errors into
 *   `LeaseAlreadyConsumed`.
 * - `disconnect()` runs `core.disconnect()` (never fails).
 */
export class MoltZapChannel implements Channel {
  readonly name = "moltzap";
  // Stale-entry-on-retry semantic via `peek` (not `consume`): when a second
  // sendMessage races a consumed lease, the entry stays in the store, the
  // server returns the typed wire error, and channel-base projects it to
  // `LeaseAlreadyConsumed`.
  private readonly dispatchLeases = new LeaseStore<string, LeaseId>();
  // Per-JID memory of the task that owns the most recent conversation seen
  // inbound. `messages/send` requires the taskId.
  private readonly taskIdsByJid = new Map<string, TaskId>();
  private readonly ownAgentId: string;

  private constructor(
    private readonly opts: ChannelOpts,
    private readonly core: MoltZapChannelCore,
    service: ChannelService,
    private readonly evalMode: boolean = false,
  ) {
    this.ownAgentId = service.ownAgentId ?? "";
    this.attachCore(core);
  }

  static fromService(
    opts: ChannelOpts,
    service: ChannelService,
    evalMode = false,
  ): MoltZapChannel {
    return new MoltZapChannel(
      opts,
      new MoltZapChannelCore({ service }),
      service,
      evalMode,
    );
  }

  private attachCore(core: MoltZapChannelCore): void {
    core.onInbound((msg: EnrichedInboundMessage) =>
      Effect.sync(() => this.handleInbound(msg)),
    );
    core.onDisconnect(() => {
      Effect.runFork(
        Effect.logWarning("MoltZap disconnected").pipe(
          Effect.annotateLogs({ channel: "moltzap" }),
        ),
      );
    });
    core.onReconnect(() => {
      Effect.runFork(
        Effect.logInfo("MoltZap reconnected").pipe(
          Effect.annotateLogs({ channel: "moltzap" }),
        ),
      );
    });
  }

  connect() {
    // `core.connect()` is already an Effect — just run it at the nanoclaw
    // Channel boundary, which imposes a Promise contract.
    return Effect.runPromise(
      this.core.connect().pipe(
        Effect.tap(() =>
          Effect.logInfo("MoltZap connected").pipe(
            Effect.annotateLogs({ channel: "moltzap" }),
          ),
        ),
        Effect.asVoid,
      ),
    );
  }

  /**
   * Outbound reply path with single-use lease semantics: the FIRST send
   * consumes the lease via `core.sendReply`. Any subsequent send for the
   * same JID within the same dispatch finds the lease entry STILL in the
   * store (peek-style, no removal) AND the lease in `CONSUMED` state
   * server-side; the typed wire error
   * (`RpcServerError(data.reason="LeaseInvalid")`) flows through
   * channel-base's `catchLeaseInvalid` and surfaces to nanoclaw as the
   * canonical `LeaseAlreadyConsumed` tagged error. Keeping the entry makes
   * the duplicate-send surface uniform: a second send is rejected rather
   * than silently re-sent unleased.
   */
  sendMessage(jid: string, text: string) {
    return Effect.runPromise(this.sendMessageEffect(jid, text));
  }

  isConnected(): boolean {
    return this.core.isConnected();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MOLTZAP_JID_PREFIX);
  }

  disconnect() {
    return Effect.runPromise(this.core.disconnect().pipe(Effect.asVoid));
  }

  private sendMessageEffect(
    jid: string,
    text: string,
  ): Effect.Effect<
    void,
    LeaseAlreadyConsumed | MoltZapChannelError | ServiceRpcError
  > {
    return Effect.gen(this, function* () {
      if (!this.ownsJid(jid)) {
        return yield* Effect.fail(
          new MoltZapChannelError({
            reason: `MoltZap channel does not own jid: ${jid}`,
          }),
        );
      }
      const leaseEntry = yield* this.dispatchLeases.peek(jid);
      const leaseId = Option.getOrUndefined(leaseEntry);
      const taskId = this.taskIdsByJid.get(jid);
      if (taskId === undefined) {
        return yield* Effect.fail(
          new MoltZapChannelError({
            reason: `MoltZap channel has no taskId for jid: ${jid}`,
          }),
        );
      }
      yield* this.core
        .sendReply(
          taskId,
          conversationIdFromJid(jid),
          text,
          leaseId !== undefined ? { dispatchLeaseId: leaseId } : {},
        )
        .pipe(
          catchLeaseInvalid(leaseId !== undefined ? { leaseId } : undefined),
        );
      // Keep the lease entry: a second sendMessage for the same JID re-uses
      // the consumed lease and triggers the server's CONSUMED rejection
      // (single-use semantics).
    });
  }

  private handleInbound(enriched: EnrichedInboundMessage): void {
    const chatJid = jidFromConversationId(enriched.conversationId);
    this.rememberDispatchLease(chatJid, enriched);
    this.taskIdsByJid.set(chatJid, enriched.taskId);
    this.maybeAutoRegister(chatJid, enriched.conversationId);
    this.emitChatMetadata(chatJid, enriched);
    this.opts.onMessage(chatJid, this.toNewMessage(chatJid, enriched));
  }

  private rememberDispatchLease(
    chatJid: string,
    enriched: EnrichedInboundMessage,
  ): void {
    if (enriched.dispatchLeaseId) {
      Effect.runSync(
        this.dispatchLeases.remember(chatJid, enriched.dispatchLeaseId),
      );
    }
  }

  private maybeAutoRegister(chatJid: string, conversationId: string): void {
    // Auto-register unknown conversations only in MOLTZAP_EVAL_MODE (smoke
    // tests); production registration flows through the runtime adapter.
    if (this.evalMode) {
      this.ensureAutoRegistered(chatJid, conversationId);
    }
  }

  private emitChatMetadata(
    chatJid: string,
    enriched: EnrichedInboundMessage,
  ): void {
    this.opts.onChatMetadata({
      chatJid,
      timestamp: enriched.createdAt,
      name: enriched.conversationMeta?.name,
      channel: "moltzap",
      isGroup: enriched.conversationMeta?.type === "group",
    });
  }

  // Nanoclaw's router consumes NewMessage.content verbatim into prompt XML,
  // so structured context blocks are rendered as `<system-reminder>` markup
  // here via channel-base's `xml-system-reminder` variant.
  private contentFor(enriched: EnrichedInboundMessage): string {
    const blocks: string[] = [];
    const crossConv = formatCrossConv(
      enriched.contextBlocks.crossConversationMessages ?? [],
      { ownAgentId: this.ownAgentId, markup: "xml-system-reminder" },
    );
    if (crossConv !== null) blocks.push(crossConv);
    const groupFields = getGroupFields(enriched.contextBlocks.groupMetadata);
    if (groupFields !== null) {
      blocks.push(
        formatGroupBlock(groupFields, { markup: "xml-system-reminder" }),
      );
    }
    if (blocks.length === 0) return enriched.text;
    return `${blocks.join("\n\n")}\n\n${enriched.text}`;
  }

  private toNewMessage(
    chatJid: string,
    enriched: EnrichedInboundMessage,
  ): NewMessage {
    return {
      id: enriched.id,
      chat_jid: chatJid,
      sender: enriched.sender.id,
      sender_name: enriched.sender.name ?? enriched.sender.id,
      content: this.contentFor(enriched),
      timestamp: enriched.createdAt,
      is_from_me: enriched.isFromMe,
      reply_to_message_id: enriched.replyToId,
    };
  }

  private ensureAutoRegistered(chatJid: string, conversationId: string): void {
    const registered = this.opts.registeredGroups();
    if (registered[chatJid]) return;
    // Mutates the live map — registry exposes it via registeredGroups() in
    // nanoclaw 1.2.52 (no setter).
    registered[chatJid] = {
      name: `eval-${conversationId.slice(0, EVAL_GROUP_NAME_ID_CHARS)}`,
      folder: `eval_${conversationId.slice(0, EVAL_GROUP_NAME_ID_CHARS)}`,
      trigger: ".*",
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    };
  }
}

export function makeMoltZapChannel(
  opts: ChannelOpts,
  evalMode = loadMoltZapEvalMode(),
): Effect.Effect<MoltZapChannel, unknown> {
  return Effect.gen(function* () {
    const service = yield* MoltZapService.make(
      opts.profileName ?? loadMoltZapChannelEnv().profileName,
    );
    return MoltZapChannel.fromService(opts, service, evalMode);
  }).pipe(Effect.withSpan("makeMoltZapChannel"));
}

registerChannel("moltzap", (opts: ChannelOpts) => {
  const { evalMode, profileName } = loadMoltZapChannelEnv();
  return makeMoltZapChannel({ ...opts, profileName }, evalMode);
});
