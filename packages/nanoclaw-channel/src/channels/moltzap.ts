/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
  Stream,
} from "effect";
import { harnessClientForProfile } from "@moltzap/client";
import type {
  HarnessClientService,
  HarnessTurn,
} from "@moltzap/client/harness-client";
import {
  BoundedMap,
  formatCrossConv,
  formatGroupBlock,
  getGroupFields,
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
// unknown conversation, and a host callback that rejects a projected turn.
// Reply failures keep the error type supplied by their backing client.
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
 * A scoped acquisition of the adapter-facing Harness capability. The adapter
 * opens the scope in `setup` and closes it in `teardown`, so the acquisition
 * describes the whole client lifetime rather than a borrowed connection.
 */
export type HarnessClientAcquisition = Effect.Effect<
  HarnessClientService,
  Error,
  Scope.Scope
>;

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

/**
 * Nanoclaw channel adapter for MoltZap. Presents Nanoclaw's `ChannelAdapter`
 * contract over a Harness client whose lifetime this adapter owns.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Nano as nanoclaw channel host
 *   participant Adapter as MoltZapAdapter
 *   participant Client as HarnessClient
 *   participant Router as nanoclaw router
 *   Nano->>Adapter: setup(config)
 *   note over Adapter: Step 1 — Scope.make<br>the adapter owns the client scope
 *   Adapter->>Client: Step 2 — acquire within that scope
 *   Client-->>Adapter: Step 3 — HarnessTurn per inbound
 *   note over Adapter: Step 4 — jidFromConversationId<br>platformId = "mz:" + conversationId
 *   note over Adapter: Step 5 — rememberReplyRoute<br>turn.reply retained by jid
 *   note over Adapter: Step 6 — ensureEvalWiring (eval mode only)<br>conversation rows target the harness-seeded agent
 *   Adapter->>Router: Step 7 — setup.onMetadata(jid, name, isGroup)
 *   Adapter->>Router: Step 8 — setup.onInbound(jid, null, message)
 *   Nano->>Adapter: teardown()
 *   note over Adapter: Step 9 — Scope.close<br>the client and its daemon go with it
 * ```
 *
 * Nanoclaw writes model output to its session outbox and calls `deliver`
 * asynchronously, after the inbound callback may already have returned. The
 * per-jid entry therefore retains the newest bound reply authority.
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
    HarnessTurn["reply"]
  >(MAX_TRACKED_CONVERSATIONS);
  private readonly acquireClient: HarnessClientAcquisition;
  private readonly evalMode: boolean;
  // The host may overlap lifecycle calls. Holding this permit through client
  // acquisition and scope closure ensures teardown observes pending setup,
  // and concurrent setup calls share the same acquired client.
  private readonly lifecycleTransition = Effect.runSync(
    Effect.makeSemaphore(1),
  );
  private ownAgentId = "";
  private harnessScope: Scope.CloseableScope | null = null;
  private harnessDrainFiber: Fiber.RuntimeFiber<void> | null = null;
  private harnessConnected = false;
  private setupConfig: ChannelSetup | null = null;

  private constructor(
    acquireClient: HarnessClientAcquisition,
    evalMode: boolean,
  ) {
    this.acquireClient = acquireClient;
    this.evalMode = evalMode;
  }

  /**
   * Creates an adapter that owns one Harness client acquisition.
   *
   * Nanoclaw builds channel adapters from a zero-argument factory at module
   * import, so no caller exists to hold a `Scope` across the adapter's
   * lifetime. The acquisition stays a lazy description here and is run inside
   * an adapter-owned scope by `setup`.
   * @param acquireClient Scoped acquisition of the adapter-facing capability.
   * @param evalMode Whether first inbound creates NanoClaw eval wiring.
   * @returns An adapter whose replies use authorities carried by Harness turns.
   */
  static fromHarnessAcquisition(
    acquireClient: HarnessClientAcquisition,
    evalMode = false,
  ): MoltZapAdapter {
    return new MoltZapAdapter(acquireClient, evalMode);
  }

  setup(config: ChannelSetup) {
    return Effect.runPromise(
      this.lifecycleTransition.withPermits(1)(
        Effect.sync(() => {
          this.setupConfig = config;
        }).pipe(
          Effect.zipRight(this.connect()),
          Effect.tap(() =>
            Effect.logInfo("MoltZap connected").pipe(
              Effect.annotateLogs({ channel: MOLTZAP_CHANNEL }),
            ),
          ),
        ),
      ),
    );
  }

  teardown() {
    return Effect.runPromise(
      this.lifecycleTransition.withPermits(1)(this.disconnect()),
    );
  }

  isConnected(): boolean {
    return this.harnessConnected;
  }

  /**
   * Outbound reply path: the reply uses the authority retained by the jid's
   * most recent inbound, keeping its exact bound closure.
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

  // The scope is opened here rather than at construction so a channel the
  // host never starts spawns no daemon, and a failed acquisition leaves the
  // adapter with no half-open scope to close.
  private connect(): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        if (this.harnessScope !== null) {
          return;
        }
        const scope = yield* Scope.make();
        const client = yield* Scope.extend(this.acquireClient, scope).pipe(
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
        this.harnessScope = scope;
        this.ownAgentId = client.agentId;
        yield* this.startHarnessDrain(client);
      }.bind(this),
    );
  }

  private disconnect(): Effect.Effect<void> {
    return this.stopHarnessDrain().pipe(
      Effect.zipRight(
        Effect.suspend(() => {
          const scope = this.harnessScope;
          this.harnessScope = null;
          return scope === null
            ? Effect.void
            : Scope.close(scope, Exit.succeed(undefined));
        }),
      ),
    );
  }

  private deliverEffect(jid: string, text: string): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        if (!this.ownsJid(jid)) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel does not own jid: ${jid}`,
          });
        }
        const reply = this.replyRoutesByJid.get(jid);
        if (reply === undefined) {
          return yield* new MoltZapChannelError({
            reason: `MoltZap channel has no conversation for jid: ${jid}`,
          });
        }
        yield* reply(text);
      }.bind(this),
    );
  }

  private rememberReplyRoute(jid: string, reply: HarnessTurn["reply"]): void {
    this.replyRoutesByJid.set(jid, reply);
  }

  private handleInbound(
    turn: HarnessTurn,
  ): Effect.Effect<void, MoltZapChannelError> {
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        // Own outbound replies echo back through the notification stream; the
        // router has no is-from-me concept, so they are dropped here.
        if (turn.isFromMe) {
          return;
        }
        const config = this.setupConfig;
        if (config === null) {
          return;
        }
        const prepared = yield* Effect.try({
          try: () => {
            const jid = jidFromConversationId(turn.conversationId);
            this.rememberReplyRoute(jid, turn.reply);
            const isGroup = turn.conversationMeta?.type === "group";
            if (this.evalMode) {
              this.ensureEvalWiring(jid, turn, isGroup);
            }
            config.onMetadata(jid, turn.conversationMeta?.name, isGroup);
            return {
              jid,
              message: this.toInboundMessage(turn, isGroup),
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
            this.handleInbound(turn).pipe(
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
    return Effect.suspend(() => {
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
    });
  }

  // Nanoclaw's router consumes the content text verbatim into prompt XML,
  // so structured context blocks are rendered as `<system-reminder>` markup
  // here via channel-base's `xml-system-reminder` variant.
  private contentFor(turn: HarnessTurn): string {
    const blocks: string[] = [];
    const crossConv = formatCrossConv(
      turn.contextBlocks.crossConversationMessages ?? [],
      { ownAgentId: this.ownAgentId, markup: "xml-system-reminder" },
    );
    if (crossConv !== null) {
      blocks.push(crossConv);
    }
    const groupFields = getGroupFields(turn.contextBlocks.groupMetadata);
    if (groupFields !== null) {
      blocks.push(
        formatGroupBlock(groupFields, { markup: "xml-system-reminder" }),
      );
    }
    if (blocks.length === 0) {
      return turn.text;
    }
    return `${blocks.join("\n\n")}\n\n${turn.text}`;
  }

  private toInboundMessage(
    turn: HarnessTurn,
    isGroup: boolean,
  ): InboundMessage {
    return {
      id: turn.id,
      kind: "chat",
      content: {
        text: this.contentFor(turn),
        sender: turn.sender.name ?? turn.sender.id,
        senderId: `${MOLTZAP_CHANNEL}:${turn.sender.id}`,
      },
      timestamp: turn.createdAt,
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
   * @param turn Value supplied to the operation.
   * @param isGroup Value supplied to the operation.
   */
  private ensureEvalWiring(
    jid: string,
    turn: HarnessTurn,
    isGroup: boolean,
  ): void {
    if (getMessagingGroupByPlatform(MOLTZAP_CHANNEL, jid) !== undefined) {
      return;
    }
    this.createEvalWiring(jid, turn, isGroup);
  }

  // Persisted policy fields come from MOLTZAP_CONTEXT_DEFAULTS so the wiring
  // row cannot drift from the declared channel contract. Row ids derive from
  // the full conversation id, making the platform lookup the freshness guard.
  private createEvalWiring(
    jid: string,
    turn: HarnessTurn,
    isGroup: boolean,
  ): void {
    const now = new Date().toISOString();
    const shortId = turn.conversationId.slice(0, EVAL_NAME_ID_CHARS);
    const messagingGroupId = `mg-eval-${turn.conversationId}`;
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: MOLTZAP_CHANNEL,
      platform_id: jid,
      name: turn.conversationMeta?.name ?? `eval-${shortId}`,
      is_group: isGroup ? 1 : 0,
      unknown_sender_policy: MOLTZAP_CONTEXT_DEFAULTS.unknownSenderPolicy,
      created_at: now,
    });
    createMessagingGroupAgent({
      id: `mga-eval-${turn.conversationId}`,
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
 * Builds the adapter nanoclaw registers for this channel. The profile name is
 * the only input the production composition needs: the slot carries the
 * loopback port its daemon binds, and `harnessClientForProfile` derives the
 * daemon child, the endpoint, and the checkpoint store from it.
 * @param env Channel environment; read from the process environment when omitted.
 * @returns The created molt zap adapter.
 */
export function makeMoltZapAdapter(
  env?: MoltZapChannelEnv,
): MoltZapAdapter | null {
  const resolvedEnv = env ?? loadMoltZapChannelEnv();
  if (resolvedEnv.profileName === null) {
    return null;
  }
  return MoltZapAdapter.fromHarnessAcquisition(
    harnessClientForProfile(resolvedEnv.profileName),
    resolvedEnv.evalMode,
  );
}

registerChannelAdapter(MOLTZAP_CHANNEL, {
  factory: () => makeMoltZapAdapter(),
  defaults: MOLTZAP_DEFAULTS,
});

/* eslint-enable jsdoc/text-escaping -- Restore strict defaults after the scoped file-level exception. */
