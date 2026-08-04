/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Fiber,
  Match,
  Option,
  Stream,
} from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import type {
  HarnessClientService,
  HarnessTurn,
} from "@moltzap/client/harness-client";
import type { ConversationId } from "@moltzap/protocol/conversation";
import {
  BoundedMap,
  MoltZapChannelCore,
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

// `MoltZapChannelError` covers nanoclaw's host-shape failures: un-owned jid,
// unknown conversation, disconnected channel. Reply failures keep the error
// type supplied by their backing client.
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
 * `mz:<conversationId>` platform ids, and replies read their bound route from
 * the per-jid map rather than re-parsing the jid.
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
  readonly harnessClient: HarnessClientService | null;
  readonly ownAgentId: string;
  readonly evalMode: boolean;
  readonly profileName: string | null;
}

type ConversationReplyRoute =
  | {
      readonly _tag: "legacy";
      readonly conversationId: ConversationId;
    }
  | {
      readonly _tag: "harness";
      readonly reply: HarnessTurn["reply"];
    };

/**
 * Nanoclaw channel adapter for MoltZap. Presents Nanoclaw's
 * `ChannelAdapter` contract over either the transitional channel core or an
 * injected `HarnessClient`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Source as HarnessClient or MoltZapChannelCore
 *   participant Handler as handleInbound (this adapter)
 *   participant Router as nanoclaw router
 *   Source->>Handler: HarnessTurn or enriched inbound
 *   note over Handler: Step 1 — jidFromConversationId<br>platformId = "mz:" + conversationId
 *   note over Handler: Step 2 — rememberReplyRoute<br>latest reply authority retained by jid
 *   note over Handler: Step 3 — ensureEvalWiring (eval mode only)<br>conversation rows target the harness-seeded agent
 *   Handler->>Router: Step 4 — setup.onMetadata(jid, name, isGroup)
 *   Handler->>Router: Step 5 — setup.onInbound(jid, null, message)
 *   Router-->>Handler: Step 6 — callback resolves
 * ```
 *
 * Nanoclaw writes model output to its session outbox and calls `deliver`
 * asynchronously, after the inbound callback may already have returned. The
 * per-jid entry therefore retains the newest bound reply authority instead of
 * reducing a Harness turn back to a generic conversation send.
 */
export class MoltZapAdapter implements ChannelAdapter {
  readonly name = MOLTZAP_CHANNEL;
  readonly channelType = MOLTZAP_CHANNEL;
  readonly supportsThreads = false;
  readonly defaults = MOLTZAP_DEFAULTS;

  // Nanoclaw delivers model output asynchronously through a jid, so the
  // newest inbound for that jid retains its exact reply route. Bounded: an
  // evicted conversation degrades to the unknown-jid deliver error until its
  // next inbound refreshes the entry.
  private readonly replyRoutesByJid = new BoundedMap<
    string,
    ConversationReplyRoute
  >(MAX_TRACKED_CONVERSATIONS);
  private ownAgentId: string;
  private core: MoltZapChannelCore | null;
  private readonly harnessClient: HarnessClientService | null;
  private harnessDrainFiber: Fiber.RuntimeFiber<void> | null = null;
  private harnessConnected = false;
  private setupConfig: ChannelSetup | null = null;
  private readonly evalMode: boolean;
  private readonly profileName: string | null;

  private constructor(state: MoltZapAdapterState) {
    this.core = state.core;
    this.harnessClient = state.harnessClient;
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
      harnessClient: null,
      ownAgentId: service.ownAgentId ?? "",
      evalMode,
      profileName: null,
    });
  }

  static fromProfile(profileName: string, evalMode = false): MoltZapAdapter {
    return new MoltZapAdapter({
      core: null,
      harnessClient: null,
      ownAgentId: "",
      evalMode,
      profileName,
    });
  }

  /**
   * Creates an adapter over an already acquired Harness client. The caller
   * owns the client's scope; adapter teardown interrupts only this adapter's
   * turn drain.
   * @param harnessClient Adapter-facing Harness capability.
   * @param evalMode Whether first inbound creates NanoClaw eval wiring.
   * @returns An adapter whose replies use authorities carried by Harness turns.
   */
  static fromHarnessClient(
    harnessClient: HarnessClientService,
    evalMode = false,
  ): MoltZapAdapter {
    return new MoltZapAdapter({
      core: null,
      harnessClient,
      ownAgentId: harnessClient.agentId,
      evalMode,
      profileName: null,
    });
  }

  setup(config: ChannelSetup) {
    this.setupConfig = config;
    const harnessClient = this.harnessClient;
    if (harnessClient !== null) {
      return Effect.runPromise(
        this.startHarnessDrain(harnessClient).pipe(
          Effect.tap(() =>
            Effect.logInfo("MoltZap connected").pipe(
              Effect.annotateLogs({ channel: MOLTZAP_CHANNEL }),
            ),
          ),
        ),
      );
    }
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
    if (this.harnessClient !== null) {
      return Effect.runPromise(this.stopHarnessDrain());
    }
    const core = this.core;
    return Effect.runPromise(
      core === null ? Effect.void : core.disconnect().pipe(Effect.asVoid),
    );
  }

  isConnected(): boolean {
    return this.harnessClient === null
      ? (this.core?.isConnected() ?? false)
      : this.harnessConnected;
  }

  /**
   * Outbound reply path: the reply uses the route retained by the jid's most
   * recent inbound. Harness-backed routes keep their exact bound closure.
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
    core.onInbound((msg: EnrichedInboundMessage) =>
      this.handleInbound(msg, {
        _tag: "legacy",
        conversationId: msg.conversationId,
      }),
    );
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
  ): Effect.Effect<void, Error | ServiceRpcError> {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        if (!this.ownsJid(jid)) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel does not own jid: ${jid}`,
          });
        }
        const route = this.replyRoutesByJid.get(jid);
        if (route === undefined) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel has no conversation for jid: ${jid}`,
          });
        }
        yield* Match.value(route).pipe(
          Match.tag("harness", ({ reply }) =>
            this.deliverHarnessReply(reply, text),
          ),
          Match.tag("legacy", ({ conversationId }) =>
            this.deliverLegacyReply(conversationId, text),
          ),
          Match.exhaustive,
        );
      }.bind(this),
    );
  }

  private deliverHarnessReply(
    reply: HarnessTurn["reply"],
    text: string,
  ): Effect.Effect<void, Error> {
    return reply(text);
  }

  private deliverLegacyReply(
    conversationId: ConversationId,
    text: string,
  ): Effect.Effect<void, MoltZapChannelError | ServiceRpcError> {
    const core = this.core;
    return core === null
      ? new MoltZapChannelError({
          reason: "MoltZap channel is not connected",
        })
      : core.sendReply(conversationId, text);
  }

  private rememberReplyRoute(jid: string, route: ConversationReplyRoute): void {
    this.replyRoutesByJid.set(jid, route);
  }

  private handleInbound(
    enriched: EnrichedInboundMessage,
    route: ConversationReplyRoute,
  ): Effect.Effect<void, MoltZapChannelError> {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        // Own outbound replies echo back through the notification stream; the
        // router has no is-from-me concept, so they are dropped here.
        if (enriched.isFromMe) {
          return;
        }
        const config = this.setupConfig;
        if (config === null) {
          return;
        }
        const prepared = yield* Effect.try({
          try: () => {
            const jid = jidFromConversationId(enriched.conversationId);
            this.rememberReplyRoute(jid, route);
            const isGroup = enriched.conversationMeta?.type === "group";
            if (this.evalMode) {
              this.ensureEvalWiring(jid, enriched, isGroup);
            }
            config.onMetadata(jid, enriched.conversationMeta?.name, isGroup);
            return {
              jid,
              message: this.toInboundMessage(enriched, isGroup),
            };
          },
          catch: (cause) =>
            new MoltZapChannelError({
              reason: `nanoclaw inbound projection failed: ${String(cause)}`,
            }),
        });
        yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              config.onInbound(prepared.jid, null, prepared.message),
            ),
          catch: (cause) =>
            new MoltZapChannelError({
              reason: `nanoclaw inbound dispatch failed for ${prepared.jid}: ${String(cause)}`,
            }),
        });
      }.bind(this),
    );
  }

  private startHarnessDrain(
    harnessClient: HarnessClientService,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.harnessDrainFiber !== null) {
        return;
      }
      this.harnessConnected = true;
      const fiber = Effect.runFork(
        harnessClient.turns.pipe(
          Stream.runForEach((turn) =>
            this.handleInbound(turn, {
              _tag: "harness",
              reply: turn.reply,
            }).pipe(
              Effect.catchAll((cause) =>
                this.logHarnessTurnFailure(turn, cause),
              ),
              Effect.catchAllDefect((cause) =>
                this.logHarnessTurnFailure(turn, cause),
              ),
            ),
          ),
          Effect.catchAll((cause) =>
            Effect.logWarning("MoltZap disconnected").pipe(
              Effect.annotateLogs({
                channel: MOLTZAP_CHANNEL,
                cause: String(cause),
              }),
            ),
          ),
        ),
      );
      this.harnessDrainFiber = fiber;
      fiber.addObserver(() => {
        this.clearHarnessDrain(fiber);
      });
    });
  }

  private logHarnessTurnFailure(
    turn: HarnessTurn,
    cause: unknown,
  ): Effect.Effect<void> {
    return Effect.logError("MoltZap inbound dispatch failed").pipe(
      Effect.annotateLogs({
        channel: MOLTZAP_CHANNEL,
        conversationId: turn.conversationId,
        cause: String(cause),
      }),
    );
  }

  private clearHarnessDrain(fiber: Fiber.RuntimeFiber<void>): void {
    if (this.harnessDrainFiber === fiber) {
      this.harnessDrainFiber = null;
      this.harnessConnected = false;
    }
  }

  private stopHarnessDrain(): Effect.Effect<void> {
    const fiber = this.harnessDrainFiber;
    this.harnessConnected = false;
    return fiber === null
      ? Effect.void
      : Fiber.interrupt(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.clearHarnessDrain(fiber);
            }),
          ),
          Effect.asVoid,
        );
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
