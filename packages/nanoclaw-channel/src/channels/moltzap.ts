/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import {
  BoundedMap,
  type LeaseAlreadyConsumed,
  LeaseStore,
  MoltZapChannelCore,
  catchLeaseInvalid,
  formatCrossConv,
  formatGroupBlock,
  getGroupFields,
  type ChannelService,
  type EnrichedInboundMessage,
} from "@moltzap/client/channel-base";

import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from "./adapter.js";
import { registerChannelAdapter } from "./channel-registry.js";
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from "../db/messaging-groups.js";
import type { MessagingGroupAgent } from "../types.js";

// `MoltZapChannelError` covers nanoclaw's host-shape failures that are NOT
// lease-related (un-owned jid, unknown conversation). Lease errors flow
// through channel-base's `LeaseAlreadyConsumed` instead.
class MoltZapChannelError extends Data.TaggedError("MoltZapChannelError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const MOLTZAP_CHANNEL = "moltzap";
const MOLTZAP_JID_PREFIX = "mz:";
const EVAL_NAME_ID_CHARS = 8;
const MAX_TRACKED_CONVERSATIONS = 4096;
/** Provides the eval agent group id runtime value. */
export const EVAL_AGENT_GROUP_ID = "eval-agent";

// Every message a MoltZap conversation delivers is addressed to this agent
// (the server routes per-conversation), so wirings engage on everything and
// no platform mention concept exists. Eval rows read every persisted policy
// field from this declaration so adapter defaults and router storage agree.
const MOLTZAP_CONTEXT_DEFAULTS = {
  engageMode: "pattern",
  engagePattern: ".",
  threads: false,
  unknownSenderPolicy: "public",
  senderScope: "all",
  ignoredMessagePolicy: "drop",
  sessionMode: "shared",
  priority: 0,
} as const satisfies ChannelDefaults["dm"] & {
  readonly senderScope: MessagingGroupAgent["sender_scope"];
  readonly ignoredMessagePolicy: MessagingGroupAgent["ignored_message_policy"];
  readonly sessionMode: MessagingGroupAgent["session_mode"];
  readonly priority: MessagingGroupAgent["priority"];
};

const MOLTZAP_DEFAULTS: ChannelDefaults = {
  dm: MOLTZAP_CONTEXT_DEFAULTS,
  group: MOLTZAP_CONTEXT_DEFAULTS,
  mentions: "never",
};

const moltZapEvalModeEnv = Config.string("MOLTZAP_EVAL_MODE").pipe(
  Config.withDefault("0"),
);
const moltZapChannelEnv = Config.all({
  profileName: Config.option(Config.string("MOLTZAP_PROFILE")),
  evalMode: moltZapEvalModeEnv,
});

/**
 * MoltZap conversationId → nanoclaw platform id. The router addresses
 * conversations by `(channelType, platformId)`; this channel uses
 * `mz:<conversationId>` platform ids, and replies read the branded
 * conversation id back from the per-jid map rather than re-parsing the jid.
 * @param conversationId Value supplied to the operation.
 * @returns The jid from conversation id result.
 */
function jidFromConversationId(conversationId: string): string {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
}

interface MoltZapChannelEnv {
  readonly profileName: string | null;
  readonly evalMode: boolean;
}

function loadMoltZapChannelEnv(): MoltZapChannelEnv {
  const env = Effect.runSync(
    moltZapChannelEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
  return {
    profileName: Option.getOrNull(env.profileName),
    evalMode: env.evalMode === "1",
  };
}

function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (
    content !== null &&
    typeof content === "object" &&
    "text" in content &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return null;
}

interface MoltZapAdapterState {
  readonly core: MoltZapChannelCore | null;
  readonly ownAgentId: string;
  readonly evalMode: boolean;
  readonly profileName: string | null;
}

/**
 * Nanoclaw channel adapter for MoltZap. Wraps `MoltZapChannelCore` from
 * `@moltzap/client` and presents nanoclaw's `ChannelAdapter` contract.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Core as MoltZapChannelCore (@moltzap/client)
 *   participant Handler as handleInbound (this adapter)
 *   participant Router as nanoclaw router
 *   Core->>Handler: onInbound(enriched)<br>WS frame decoded + enriched
 *   note over Handler: Step 1 — jidFromConversationId<br>platformId = "mz:" + conversationId
 *   note over Handler: Step 2 — rememberDispatchLease<br>leaseStore.remember(jid, leaseId) if present
 *   note over Handler: Step 3 — ensureEvalWiring (eval mode only)<br>conversation rows target the harness-seeded agent
 *   Handler->>Router: Step 4 — setup.onMetadata(jid, name, isGroup)
 *   Handler->>Router: Step 5 — setup.onInbound(jid, null, message)
 *   Router-->>Handler: Step 6 — turn resolves<br>awaited, so the lease outlives the reply
 * ```
 *
 * The per-jid lease and conversation entries are only sound because Step 6 is
 * awaited: they hold the newest inbound, so a reply that outlived its own turn
 * would read a lease it did not earn. Awaiting keeps at most one turn per
 * adapter in flight, which matches the core's single-fiber inbound drain.
 *
 * Lease-store stale-entry semantic: uses `peek` (not `consume`) so a second
 * `deliver` on the same jid after a consumed lease receives the typed
 * `LeaseAlreadyConsumed` from the server instead of silently sending
 * without a lease (delivery is server-enforced single-use; the local entry
 * is intentionally stale-after-consume).
 */
export class MoltZapAdapter implements ChannelAdapter {
  readonly name = MOLTZAP_CHANNEL;
  readonly channelType = MOLTZAP_CHANNEL;
  readonly supportsThreads = false;
  readonly defaults = MOLTZAP_DEFAULTS;

  // Stale-entry-on-retry semantic via `peek` (not `consume`): when a second
  // deliver races a consumed lease, the entry stays in the store, the
  // server returns the typed wire error, and channel-base projects it to
  // `LeaseAlreadyConsumed`.
  private readonly dispatchLeases = new LeaseStore<string, LeaseId>();
  // Per-jid memory of the branded conversation id from the most recent
  // inbound. Keeping the branded id avoids re-decoding it on every reply.
  // Bounded: an evicted conversation degrades to the unknown-jid deliver
  // error until its next inbound refreshes the entry.
  private readonly conversationsByJid = new BoundedMap<
    string,
    { readonly conversationId: ConversationId }
  >(MAX_TRACKED_CONVERSATIONS);
  private ownAgentId: string;
  private core: MoltZapChannelCore | null;
  private setupConfig: ChannelSetup | null = null;
  private readonly evalMode: boolean;
  private readonly profileName: string | null;

  private constructor(state: MoltZapAdapterState) {
    this.core = state.core;
    this.ownAgentId = state.ownAgentId;
    this.evalMode = state.evalMode;
    this.profileName = state.profileName;
    if (state.core !== null) {
      this.attachCore(state.core);
    }
  }

  static fromService(
    service: ChannelService,
    evalMode = false,
  ): MoltZapAdapter {
    return new MoltZapAdapter({
      core: new MoltZapChannelCore({ service }),
      ownAgentId: service.ownAgentId ?? "",
      evalMode,
      profileName: null,
    });
  }

  static fromProfile(profileName: string, evalMode = false): MoltZapAdapter {
    return new MoltZapAdapter({
      core: null,
      ownAgentId: "",
      evalMode,
      profileName,
    });
  }

  setup(config: ChannelSetup) {
    this.setupConfig = config;
    return Effect.runPromise(
      this.initializeCore().pipe(
        Effect.flatMap((core) => core.connect()),
        Effect.tap(() =>
          Effect.logInfo("MoltZap connected").pipe(
            Effect.annotateLogs({ channel: MOLTZAP_CHANNEL }),
          ),
        ),
        Effect.asVoid,
      ),
    );
  }

  teardown() {
    const core = this.core;
    return Effect.runPromise(
      core === null ? Effect.void : core.disconnect().pipe(Effect.asVoid),
    );
  }

  isConnected(): boolean {
    return this.core?.isConnected() ?? false;
  }

  /**
   * Outbound reply path with single-use lease semantics: the FIRST deliver
   * consumes the lease via `core.sendReply`. Any subsequent deliver for the
   * same jid within the same dispatch finds the lease entry STILL in the
   * store (peek-style, no removal) AND the lease in `CONSUMED` state
   * server-side; the typed wire error flows through channel-base's
   * `catchLeaseInvalid` and surfaces as the canonical `LeaseAlreadyConsumed`
   * tagged error. Keeping the entry makes the duplicate-send surface
   * uniform: a second deliver is rejected rather than silently re-sent
   * unleased.
   * @param platformId Value supplied to the operation.
   * @param args Thread identifier and outbound message supplied by Nanoclaw.
   * @returns The text result.
   */
  deliver(
    platformId: string,
    ...args: [threadId: string | null, message: OutboundMessage]
  ) {
    const message = args[1];
    const text = extractOutboundText(message);
    const send =
      text === null ? Effect.void : this.deliverEffect(platformId, text);
    return Effect.runPromise(send.pipe(Effect.as(undefined)));
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MOLTZAP_JID_PREFIX);
  }

  private initializeCore() {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        if (this.core !== null) {
          return this.core;
        }
        const profileName = this.profileName;
        if (profileName === null) {
          return yield* new MoltZapChannelError({
            reason: "MoltZap channel has no profile for initialization",
          });
        }
        const service = yield* MoltZapService.make(profileName);
        const core = new MoltZapChannelCore({ service });
        this.core = core;
        this.ownAgentId = service.ownAgentId ?? "";
        this.attachCore(core);
        return core;
      }.bind(this),
    );
  }

  private attachCore(core: MoltZapChannelCore): void {
    core.onInbound((msg: EnrichedInboundMessage) => this.handleInbound(msg));
    core.onDisconnect(() => {
      Effect.runFork(
        Effect.logWarning("MoltZap disconnected").pipe(
          Effect.annotateLogs({ channel: MOLTZAP_CHANNEL }),
        ),
      );
    });
  }

  private deliverEffect(
    jid: string,
    text: string,
  ): Effect.Effect<
    void,
    LeaseAlreadyConsumed | MoltZapChannelError | ServiceRpcError
  > {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        if (!this.ownsJid(jid)) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel does not own jid: ${jid}`,
          });
        }
        const leaseEntry = yield* this.dispatchLeases.peek(jid);
        const leaseId = Option.getOrUndefined(leaseEntry);
        const conversation = this.conversationsByJid.get(jid);
        if (conversation === undefined) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel has no conversation for jid: ${jid}`,
          });
        }
        const core = this.core;
        if (core === null) {
          return yield* new MoltZapChannelError({
            reason: "MoltZap channel is not connected",
          });
        }
        yield* core
          .sendReply(
            conversation.conversationId,
            text,
            leaseId === undefined ? {} : { dispatchLeaseId: leaseId },
          )
          .pipe(
            catchLeaseInvalid(leaseId !== undefined ? { leaseId } : undefined),
          );
        // Keep the lease entry: a second deliver for the same jid re-uses the
        // consumed lease and triggers the server's CONSUMED rejection
        // (single-use semantics).
      }.bind(this),
    );
  }

  private rememberConversation(
    jid: string,
    enriched: EnrichedInboundMessage,
  ): void {
    this.conversationsByJid.set(jid, {
      conversationId: enriched.conversationId,
    });
  }

  // The host turn is awaited rather than forked, which is what keeps the
  // dispatch lease paired with the turn that earned it. The core holds one
  // lease in flight and drains inbound work on a single fiber, so returning
  // before the turn finishes would release that cell while the reply is still
  // pending: a later inbound would overwrite the per-jid lease and conversation
  // entries, and the earlier reply would then consume the newer lease. Awaiting
  // costs conversation-level concurrency, which the core does not offer anyway.
  private handleInbound(
    enriched: EnrichedInboundMessage,
  ): Effect.Effect<void, MoltZapChannelError> {
    return Effect.suspend(() => {
      // Own outbound replies echo back through the notification stream; the
      // router has no is-from-me concept, so they are dropped here.
      if (enriched.isFromMe) {
        return Effect.void;
      }
      const config = this.setupConfig;
      if (config === null) {
        return Effect.void;
      }
      const jid = jidFromConversationId(enriched.conversationId);
      this.rememberDispatchLease(jid, enriched);
      this.rememberConversation(jid, enriched);
      const isGroup = enriched.conversationMeta?.type === "group";
      if (this.evalMode) {
        this.ensureEvalWiring(jid, enriched, isGroup);
      }
      config.onMetadata(jid, enriched.conversationMeta?.name, isGroup);
      return Effect.tryPromise({
        try: () =>
          Promise.resolve(
            config.onInbound(
              jid,
              null,
              this.toInboundMessage(enriched, isGroup),
            ),
          ),
        catch: (cause) =>
          new MoltZapChannelError({
            reason: `nanoclaw inbound dispatch failed for ${jid}: ${String(cause)}`,
          }),
      }).pipe(Effect.asVoid);
    });
  }

  private rememberDispatchLease(
    jid: string,
    enriched: EnrichedInboundMessage,
  ): void {
    if (enriched.dispatchLeaseId) {
      Effect.runSync(
        this.dispatchLeases.remember(jid, enriched.dispatchLeaseId),
      );
    }
  }

  // Nanoclaw's router consumes the content text verbatim into prompt XML,
  // so structured context blocks are rendered as `<system-reminder>` markup
  // here via channel-base's `xml-system-reminder` variant.
  private contentFor(enriched: EnrichedInboundMessage): string {
    const blocks: string[] = [];
    const crossConv = formatCrossConv(
      enriched.contextBlocks.crossConversationMessages ?? [],
      { ownAgentId: this.ownAgentId, markup: "xml-system-reminder" },
    );
    if (crossConv !== null) {
      blocks.push(crossConv);
    }
    const groupFields = getGroupFields(enriched.contextBlocks.groupMetadata);
    if (groupFields !== null) {
      blocks.push(
        formatGroupBlock(groupFields, { markup: "xml-system-reminder" }),
      );
    }
    if (blocks.length === 0) {
      return enriched.text;
    }
    return `${blocks.join("\n\n")}\n\n${enriched.text}`;
  }

  private toInboundMessage(
    enriched: EnrichedInboundMessage,
    isGroup: boolean,
  ): InboundMessage {
    return {
      id: enriched.id,
      kind: "chat",
      content: {
        text: this.contentFor(enriched),
        sender: enriched.sender.name ?? enriched.sender.id,
        senderId: `${MOLTZAP_CHANNEL}:${enriched.sender.id}`,
      },
      timestamp: enriched.createdAt,
      isGroup,
    };
  }

  /**
   * Harness conversations come into existence during a run, so eval mode
   * creates their messaging group and wiring before the router can drop the
   * first message. The harness provisions the target agent group and its
   * container config before startup; NanoClaw's sender resolver owns user
   * rows. Production registrations stay out of band.
   * @param jid Value supplied to the operation.
   * @param enriched Value supplied to the operation.
   * @param isGroup Value supplied to the operation.
   */
  private ensureEvalWiring(
    jid: string,
    enriched: EnrichedInboundMessage,
    isGroup: boolean,
  ): void {
    if (getMessagingGroupByPlatform(MOLTZAP_CHANNEL, jid) !== undefined) {
      return;
    }
    this.createEvalWiring(jid, enriched, isGroup);
  }

  // Persisted policy fields come from MOLTZAP_CONTEXT_DEFAULTS so the wiring
  // row cannot drift from the declared channel contract. Row ids derive from
  // the full conversation id, making the platform lookup the freshness guard.
  private createEvalWiring(
    jid: string,
    enriched: EnrichedInboundMessage,
    isGroup: boolean,
  ): void {
    const now = new Date().toISOString();
    const shortId = enriched.conversationId.slice(0, EVAL_NAME_ID_CHARS);
    const messagingGroupId = `mg-eval-${enriched.conversationId}`;
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: MOLTZAP_CHANNEL,
      platform_id: jid,
      name: enriched.conversationMeta?.name ?? `eval-${shortId}`,
      is_group: isGroup ? 1 : 0,
      unknown_sender_policy: MOLTZAP_CONTEXT_DEFAULTS.unknownSenderPolicy,
      created_at: now,
    });
    createMessagingGroupAgent({
      id: `mga-eval-${enriched.conversationId}`,
      messaging_group_id: messagingGroupId,
      agent_group_id: EVAL_AGENT_GROUP_ID,
      engage_mode: MOLTZAP_CONTEXT_DEFAULTS.engageMode,
      engage_pattern: MOLTZAP_CONTEXT_DEFAULTS.engagePattern,
      sender_scope: MOLTZAP_CONTEXT_DEFAULTS.senderScope,
      ignored_message_policy: MOLTZAP_CONTEXT_DEFAULTS.ignoredMessagePolicy,
      session_mode: MOLTZAP_CONTEXT_DEFAULTS.sessionMode,
      priority: MOLTZAP_CONTEXT_DEFAULTS.priority,
      created_at: now,
    });
  }
}

/**
 * Creates molt zap adapter.
 * @param env Value supplied to the operation.
 * @returns The created molt zap adapter.
 */
export function makeMoltZapAdapter(
  env?: MoltZapChannelEnv,
): MoltZapAdapter | null {
  const resolvedEnv = env ?? loadMoltZapChannelEnv();
  if (resolvedEnv.profileName === null) {
    return null;
  }
  return MoltZapAdapter.fromProfile(
    resolvedEnv.profileName,
    resolvedEnv.evalMode,
  );
}

registerChannelAdapter(MOLTZAP_CHANNEL, {
  factory: () => makeMoltZapAdapter(),
  defaults: MOLTZAP_DEFAULTS,
});

/* eslint-enable jsdoc/text-escaping -- Restore strict defaults after the scoped file-level exception. */
