/**
 * @file Adapts MoltZap Client conversations to NanoClaw's channel contract,
 * including inbound projection, turn-bound replies, and eval-only wiring.
 */
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import {
  BoundedMap,
  type ChannelService,
  type EnrichedInboundMessage,
  formatCrossConv,
  formatGroupBlock,
  getGroupFields,
  MoltZapChannelCore,
} from "@moltzap/client/channel-base";
import { Config, ConfigProvider, Data, Effect, Option } from "effect";

import type { MessagingGroupAgent } from "../types.js";
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from "./adapter.js";
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from "../db/messaging-groups.js";
import { registerChannelAdapter } from "./channel-registry.js";

/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */

// `MoltZapChannelError` covers nanoclaw's host-shape failures: un-owned jid,
// unknown conversation, disconnected channel. Send failures keep their own
// `ServiceRpcError` type.
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
const EVAL_AGENT_GROUP_ID = "eval-agent";

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
 * @param conversationId Canonical identity carried by an inbound conversation.
 * @returns The NanoClaw platform id reserved for that conversation.
 */
const jidFromConversationId = (conversationId: string): string => {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
};

interface MoltZapChannelEnv {
  readonly profileName: string | null;
  readonly evalMode: boolean;
}

const loadMoltZapChannelEnv = (): MoltZapChannelEnv => {
  const env = Effect.runSync(
    moltZapChannelEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
  return {
    profileName: Option.getOrNull(env.profileName),
    evalMode: env.evalMode === "1",
  };
};

const extractOutboundText = (message: OutboundMessage): string | null => {
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
};

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
 *   note over Handler: Step 2 — conversationsByJid.set<br>retain the branded conversation route
 *   note over Handler: Step 3 — ensureEvalWiring (eval mode only)<br>conversation rows target the harness-seeded agent
 *   Handler->>Router: Step 4 — setup.onMetadata(jid, name, isGroup)
 *   Handler->>Router: Step 5 — setup.onInbound(jid, null, message)
 *   Router-->>Handler: Step 6 — turn resolves<br>awaited, so the reply binds to its own turn
 * ```
 *
 * The per-jid conversation entry is only sound because Step 6 is awaited: it
 * holds the newest inbound, so a reply that outlived its own turn would
 * address a conversation it did not come from. Awaiting keeps at most one turn
 * per adapter in flight, which matches the core's single-fiber inbound drain.
 */
export class MoltZapAdapter implements ChannelAdapter {
  readonly name = MOLTZAP_CHANNEL;
  readonly channelType = MOLTZAP_CHANNEL;
  readonly supportsThreads = false;
  readonly defaults = MOLTZAP_DEFAULTS;

  // Per-jid memory of the branded conversation id from the most recent
  // inbound. Keeping the branded id avoids re-decoding it on every reply.
  // Bounded: an evicted conversation degrades to the unknown-jid deliver
  // error until its next inbound refreshes the entry.
  private readonly conversationsByJid = new BoundedMap<
    string,
    { readonly conversationId: EnrichedInboundMessage["conversationId"] }
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
   * Outbound reply path: the reply addresses the conversation recorded by the
   * jid's most recent inbound, which is the turn the router is answering
   * because `handleInbound` awaits that turn.
   * @param platformId NanoClaw routing id for the conversation being answered.
   * @param args Host thread metadata and the outbound message payload.
   * @returns A promise that settles after the reply path finishes.
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
  ): Effect.Effect<void, MoltZapChannelError | ServiceRpcError> {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        if (!jid.startsWith(MOLTZAP_JID_PREFIX)) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel does not own jid: ${jid}`,
          });
        }
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
        yield* core.sendReply(conversation.conversationId, text);
      }.bind(this),
    );
  }

  // The host turn is awaited rather than forked, which is what keeps a reply
  // bound to the turn that produced it. The core drains inbound work on a
  // single fiber, so returning before the turn finishes would let a later
  // inbound overwrite the per-jid conversation entry while the earlier reply
  // is still pending, and that reply would then address the newer
  // conversation. Awaiting costs conversation-level concurrency, which the
  // core does not offer anyway.
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
      this.conversationsByJid.set(jid, {
        conversationId: enriched.conversationId,
      });
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

  /**
   * Harness conversations come into existence during a run, so eval mode
   * creates their messaging group and wiring before the router can drop the
   * first message. The harness provisions the target agent group and its
   * container config before startup; NanoClaw's sender resolver owns user
   * rows. Production registrations stay out of band.
   * @param jid NanoClaw platform id used for the messaging-group lookup.
   * @param enriched Inbound event that supplies conversation identity and metadata.
   * @param isGroup Whether NanoClaw should route the conversation as a group.
   */
  private ensureEvalWiring(
    jid: string,
    enriched: EnrichedInboundMessage,
    isGroup: boolean,
  ): void {
    if (getMessagingGroupByPlatform(MOLTZAP_CHANNEL, jid) !== undefined) {
      return;
    }
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
 * Creates the configured NanoClaw adapter when a MoltZap profile is present.
 * @param env Explicit channel environment, or process configuration when omitted.
 * @returns A profile-backed adapter, or `null` when the channel is disabled.
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
