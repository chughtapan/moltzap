/** @file Projects the reduced MoltZap Client capability into NanoClaw. */
import {
  acquireHarnessClient,
  type ConnectError,
  type Content,
  type HarnessClient,
  type HarnessTurn,
  type ReplyError,
} from "@moltzap/client";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Exit,
  Option,
  Scope,
  Stream,
} from "effect";

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

/* eslint-disable jsdoc/text-escaping -- Mermaid sequenceDiagram blocks require literal HTML5 `<br>` separators. */
/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- NanoClaw's mirrored ChannelAdapter lifecycle is Promise-based. */

/** A NanoClaw host value cannot be projected onto the active MoltZap turn. */
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
const EVAL_AGENT_GROUP_ID = "eval-agent";

// Every delivered MoltZap turn already carries live reply authority, so no
// platform mention gate applies. Eval rows copy these values so host routing
// and the adapter declaration stay aligned.
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

const moltZapChannelEnv = Config.all({
  mcpEndpoint: Config.option(Config.string("MOLTZAP_MCP_URL")).pipe(
    Config.map(Option.getOrNull),
  ),
  evalMode: Config.string("MOLTZAP_EVAL_MODE").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
});

interface MoltZapChannelEnv {
  readonly mcpEndpoint: string | null;
  readonly evalMode: boolean;
}

interface MoltZapAdapterState {
  readonly injectedClient: HarnessClient | null;
  readonly mcpEndpoint: string | null;
  readonly evalMode: boolean;
}

interface ActiveTurn {
  readonly jid: string;
  readonly reply: HarnessTurn["reply"];
}

/**
 * Convert a MoltZap conversation identity into NanoClaw host routing data.
 * @param conversationId Conversation represented by the host address.
 * @returns The NanoClaw platform id for that conversation.
 */
const jidFromConversationId = (conversationId: string): string =>
  `${MOLTZAP_JID_PREFIX}${conversationId}`;

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

const renderContent = (content: Content): string =>
  content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("\n");

const isRemoteTurn = (turn: HarnessTurn): boolean =>
  turn.peers.some((peer) => peer.agentId === turn.author.agentId);

const conversationName = (turn: HarnessTurn): string =>
  turn.peers.map((peer) => peer.agentName).join(", ");

/**
 * NanoClaw adapter backed by exactly one scoped `HarnessClient`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Client as HarnessClient
 *   participant Adapter as MoltZapAdapter
 *   participant Host as NanoClaw host
 *   Client->>Adapter: one HarnessTurn
 *   note over Adapter: bind this turn's reply
 *   Adapter->>Host: onMetadata<br>conversation and peers
 *   Adapter->>Host: await onInbound<br>author and content
 *   Host->>Adapter: deliver text
 *   Adapter->>Client: turn.reply content
 *   note over Adapter: clear reply when host turn settles
 * ```
 *
 * `Stream.runForEach` awaits each host turn. The single retained reply closure
 * therefore belongs to the current turn and is cleared before another turn is
 * handled.
 */
export class MoltZapAdapter implements ChannelAdapter {
  readonly name = MOLTZAP_CHANNEL;
  readonly channelType = MOLTZAP_CHANNEL;
  readonly supportsThreads = false;
  readonly defaults = MOLTZAP_DEFAULTS;

  private readonly injectedClient: HarnessClient | null;
  private readonly mcpEndpoint: string | null;
  private readonly evalMode: boolean;
  private setupConfig: ChannelSetup | null = null;
  private lifecycleScope: Scope.CloseableScope | null = null;
  private activeTurn: ActiveTurn | null = null;
  private connected = false;

  private constructor(state: MoltZapAdapterState) {
    this.injectedClient = state.injectedClient;
    this.mcpEndpoint = state.mcpEndpoint;
    this.evalMode = state.evalMode;
  }

  /**
   * Build an adapter around an already-acquired public Client capability.
   * @param client Scoped structural Client capability.
   * @param evalMode Whether to create simulator-owned host wiring.
   * @returns An adapter that consumes the injected Client.
   */
  static fromClient(client: HarnessClient, evalMode = false): MoltZapAdapter {
    return new MoltZapAdapter({
      injectedClient: client,
      mcpEndpoint: null,
      evalMode,
    });
  }

  /**
   * Build an adapter that acquires its Client from one loopback MCP URL.
   * @param mcpEndpoint Loopback endpoint owned by the local daemon.
   * @param evalMode Whether to create simulator-owned host wiring.
   * @returns An adapter that acquires the endpoint when set up.
   */
  static fromEndpoint(mcpEndpoint: string, evalMode = false): MoltZapAdapter {
    return new MoltZapAdapter({
      injectedClient: null,
      mcpEndpoint,
      evalMode,
    });
  }

  // #ignore-sloppy-code-next-line[promise-type]: NanoClaw's ChannelAdapter lifecycle is Promise-native at the host boundary.
  setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    return Effect.runPromise(this.start());
  }

  // #ignore-sloppy-code-next-line[promise-type]: NanoClaw's ChannelAdapter lifecycle is Promise-native at the host boundary.
  teardown(): Promise<void> {
    this.setupConfig = null;
    this.activeTurn = null;
    this.connected = false;
    const scope = this.lifecycleScope;
    this.lifecycleScope = null;
    return Effect.runPromise(
      scope === null ? Effect.void : Scope.close(scope, Exit.void),
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  deliver(
    platformId: string,
    ...args: [threadId: string | null, message: OutboundMessage]
    // #ignore-sloppy-code-next-line[promise-type]: NanoClaw's ChannelAdapter delivery contract is Promise-native at the host boundary.
  ): Promise<string | undefined> {
    return Effect.runPromise(
      this.deliverEffect(platformId, args[1]).pipe(Effect.as(undefined)),
    );
  }

  private start(): Effect.Effect<void, ConnectError | MoltZapChannelError> {
    if (this.connected) {
      return Effect.void;
    }
    return Effect.gen(
      function* (this: MoltZapAdapter) {
        const scope = yield* Scope.make();
        this.lifecycleScope = scope;
        const client = yield* this.acquireClient(scope);
        this.connected = true;
        yield* client.turns.pipe(
          Stream.runForEach((turn) => this.handleTurn(turn)),
          Effect.ensuring(
            Effect.sync(() => {
              this.connected = false;
              this.activeTurn = null;
            }),
          ),
          Effect.forkIn(scope),
        );
      }.bind(this),
    ).pipe(
      Effect.onError(() => {
        const scope = this.lifecycleScope;
        this.lifecycleScope = null;
        this.connected = false;
        return scope === null ? Effect.void : Scope.close(scope, Exit.void);
      }),
      Effect.asVoid,
    );
  }

  private acquireClient(
    scope: Scope.CloseableScope,
  ): Effect.Effect<HarnessClient, ConnectError | MoltZapChannelError> {
    if (this.injectedClient !== null) {
      return Effect.succeed(this.injectedClient);
    }
    const mcpEndpoint = this.mcpEndpoint;
    if (mcpEndpoint === null) {
      return Effect.fail(
        new MoltZapChannelError({
          reason: "MoltZap channel has no MCP endpoint",
        }),
      );
    }
    return Effect.try({
      try: () => new URL(mcpEndpoint),
      catch: () =>
        new MoltZapChannelError({
          reason: "MoltZap channel MCP endpoint is invalid",
        }),
    }).pipe(Effect.flatMap(acquireHarnessClient), Scope.extend(scope));
  }

  private deliverEffect(
    jid: string,
    message: OutboundMessage,
  ): Effect.Effect<void, MoltZapChannelError | ReplyError> {
    if (!jid.startsWith(MOLTZAP_JID_PREFIX)) {
      return Effect.fail(
        new MoltZapChannelError({
          reason: `MoltZap channel does not own jid: ${jid}`,
        }),
      );
    }
    const text = extractOutboundText(message);
    if (text === null) {
      return Effect.fail(
        new MoltZapChannelError({
          reason: "MoltZap replies require text content",
        }),
      );
    }
    const activeTurn = this.activeTurn;
    if (activeTurn === null || activeTurn.jid !== jid) {
      return Effect.fail(
        new MoltZapChannelError({
          reason: `MoltZap channel has no active turn for jid: ${jid}`,
        }),
      );
    }
    return activeTurn.reply([{ type: "text", text }]);
  }

  private handleTurn(
    turn: HarnessTurn,
  ): Effect.Effect<void, MoltZapChannelError> {
    if (!isRemoteTurn(turn)) {
      return Effect.void;
    }
    const config = this.setupConfig;
    if (config === null) {
      return Effect.void;
    }
    const jid = jidFromConversationId(turn.conversationId);
    const isGroup = turn.peers.length > 1;
    const activeTurn = { jid, reply: turn.reply } satisfies ActiveTurn;
    this.activeTurn = activeTurn;
    return Effect.tryPromise({
      try: () => {
        const name = conversationName(turn);
        if (this.evalMode) {
          this.ensureEvalWiring(jid, turn, name, isGroup);
        }
        config.onMetadata(jid, name, isGroup);
        return Promise.resolve(
          config.onInbound(jid, null, this.toInboundMessage(turn, isGroup)),
        );
      },
      catch: (cause) =>
        new MoltZapChannelError({
          reason: `NanoClaw inbound dispatch failed for ${jid}: ${String(cause)}`,
        }),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (this.activeTurn === activeTurn) {
            this.activeTurn = null;
          }
        }),
      ),
      Effect.asVoid,
    );
  }

  private toInboundMessage(
    turn: HarnessTurn,
    isGroup: boolean,
  ): InboundMessage {
    return {
      // NanoClaw requires envelope metadata that HarnessTurn intentionally
      // omits. These receipt-local values carry no MoltZap identity or proof.
      id: `mz-turn:${crypto.randomUUID()}`,
      kind: "chat",
      content: {
        text: renderContent(turn.content),
        sender: turn.author.agentName,
        senderId: `${MOLTZAP_CHANNEL}:${turn.author.agentId}`,
      },
      timestamp: new Date().toISOString(),
      isGroup,
    };
  }

  private ensureEvalWiring(
    jid: string,
    turn: HarnessTurn,
    name: string,
    isGroup: boolean,
  ): void {
    if (getMessagingGroupByPlatform(MOLTZAP_CHANNEL, jid) !== undefined) {
      return;
    }
    const now = new Date().toISOString();
    const shortId = turn.conversationId.slice(0, EVAL_NAME_ID_CHARS);
    const messagingGroupId = `mg-eval-${turn.conversationId}`;
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: MOLTZAP_CHANNEL,
      platform_id: jid,
      name: name.length === 0 ? `eval-${shortId}` : name,
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
 * Create the production adapter when a loopback MCP URL is configured.
 * @param env Explicit environment, or process configuration when omitted.
 * @returns An MCP-backed adapter, or null when the channel is disabled.
 */
export function makeMoltZapAdapter(
  env?: MoltZapChannelEnv,
): MoltZapAdapter | null {
  const resolvedEnv =
    env ??
    Effect.runSync(
      moltZapChannelEnv.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    );
  return resolvedEnv.mcpEndpoint === null
    ? null
    : MoltZapAdapter.fromEndpoint(
        resolvedEnv.mcpEndpoint,
        resolvedEnv.evalMode,
      );
}

registerChannelAdapter(MOLTZAP_CHANNEL, {
  factory: () => makeMoltZapAdapter(),
  defaults: MOLTZAP_DEFAULTS,
});

/* eslint-enable jsdoc/text-escaping -- Restore strict defaults after the Mermaid block. */
/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first defaults after the host boundary. */
