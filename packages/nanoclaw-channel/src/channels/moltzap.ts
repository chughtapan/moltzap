/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import type { ConversationId } from "@moltzap/protocol/conversation";
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
import { createAgentGroup, getAllAgentGroups } from "../db/agent-groups.js";
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from "../db/container-configs.js";
import { upsertUser } from "../modules/permissions/db/users.js";
import type { AgentGroup } from "../types.js";

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

const MOLTZAP_CHANNEL = "moltzap";
const MOLTZAP_JID_PREFIX = "mz:";
const EVAL_NAME_ID_CHARS = 8;
export const EVAL_AGENT_GROUP_ID = "eval-agent";

// Harness runs start from an empty database, so eval mode also provisions
// the agent group its wiring points at, with the container-config row the
// spawn path requires (production installs create theirs via init scripts).
function createEvalAgentGroup(): AgentGroup {
  const group: AgentGroup = {
    id: EVAL_AGENT_GROUP_ID,
    name: EVAL_AGENT_GROUP_ID,
    folder: EVAL_AGENT_GROUP_ID,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  createAgentGroup(group);
  ensureContainerConfig(group.id, null);
  applyEvalContainerDefaults(group.id);
  return group;
}

const EvalContainerDefaultsEnv = Config.all({
  model: Config.option(Config.string("MOLTZAP_AGENT_MODEL")),
  mcpServers: Config.option(Config.string("MOLTZAP_MCP_SERVERS")),
});

/**
 * The moltzap simulator honors per-agent `modelId` and MCP mounts on
 * NanoClaw through the container config of the eval agent group; the
 * spawn path materializes them into `container.json`. `MOLTZAP_MCP_SERVERS`
 * carries a JSON record of stdio server definitions.
 */
function applyEvalContainerDefaults(agentGroupId: string): void {
  const env = Effect.runSync(
    EvalContainerDefaultsEnv.pipe(
      Effect.withConfigProvider(ConfigProvider.fromEnv()),
    ),
  );
  const model = Option.getOrNull(env.model);
  if (model !== null && model.length > 0) {
    updateContainerConfigScalars(agentGroupId, { model });
  }
  const mcpServers = Option.getOrNull(env.mcpServers);
  if (mcpServers !== null && mcpServers.length > 0) {
    updateContainerConfigJson(
      agentGroupId,
      "mcp_servers",
      JSON.parse(mcpServers),
    );
  }
}

// Every message a MoltZap conversation delivers is addressed to this agent
// (the server routes per-conversation), so wirings engage on everything and
// no platform mention concept exists.
const MOLTZAP_CONTEXT_DEFAULTS = {
  engageMode: "pattern",
  engagePattern: ".",
  threads: false,
  unknownSenderPolicy: "public",
} as const;

const MOLTZAP_DEFAULTS: ChannelDefaults = {
  dm: MOLTZAP_CONTEXT_DEFAULTS,
  group: MOLTZAP_CONTEXT_DEFAULTS,
  mentions: "never",
};

const MoltZapEvalModeEnv = Config.string("MOLTZAP_EVAL_MODE").pipe(
  Config.withDefault("0"),
);
const MoltZapChannelEnv = Config.all({
  profileName: Config.option(Config.string("MOLTZAP_PROFILE")),
  evalMode: MoltZapEvalModeEnv,
});

/**
 * MoltZap conversationId → nanoclaw platform id. The router addresses
 * conversations by `(channelType, platformId)`; this channel uses
 * `mz:<conversationId>` platform ids, and replies read the branded
 * conversation id back from the per-jid map rather than re-parsing the jid.
 */
function jidFromConversationId(conversationId: string): string {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
}

function loadMoltZapChannelEnv(): {
  readonly profileName: string | null;
  readonly evalMode: boolean;
} {
  const env = Effect.runSync(
    MoltZapChannelEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
  return {
    profileName: Option.getOrNull(env.profileName),
    evalMode: env.evalMode === "1",
  };
}

function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
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
 *   note over Handler: Step 3 — ensureEvalWiring (eval mode only)<br>messaging_group + wiring created BEFORE delivery
 *   Handler->>Router: Step 4 — setup.onMetadata(jid, name, isGroup)
 *   Handler->>Router: Step 5 — setup.onInbound(jid, null, message)
 * ```
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
  // Per-jid memory of the task and branded conversation id from the most
  // recent inbound. `agent/message/send` requires both; keeping the branded
  // id avoids re-decoding it on every reply.
  private readonly conversationsByJid = new Map<
    string,
    { readonly taskId: TaskId; readonly conversationId: ConversationId }
  >();
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
   */
  deliver(
    platformId: string,
    _threadId: string | null,
    message: OutboundMessage,
  ) {
    const text = extractOutboundText(message);
    const send =
      text === null ? Effect.void : this.deliverEffect(platformId, text);
    return Effect.runPromise(send.pipe(Effect.as(undefined)));
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MOLTZAP_JID_PREFIX);
  }

  private initializeCore() {
    return Effect.gen(this, function* () {
      if (this.core !== null) {
        return this.core;
      }
      const profileName = this.profileName;
      if (profileName === null) {
        return yield* Effect.fail(
          new MoltZapChannelError({
            reason: "MoltZap channel has no profile for initialization",
          }),
        );
      }
      const service = yield* MoltZapService.make(profileName);
      const core = new MoltZapChannelCore({ service });
      this.core = core;
      this.ownAgentId = service.ownAgentId ?? "";
      this.attachCore(core);
      return core;
    });
  }

  private attachCore(core: MoltZapChannelCore): void {
    core.onInbound((msg: EnrichedInboundMessage) =>
      Effect.sync(() => this.handleInbound(msg)),
    );
    core.onDisconnect(() => {
      Effect.runFork(
        Effect.logWarning("MoltZap disconnected").pipe(
          Effect.annotateLogs({ channel: MOLTZAP_CHANNEL }),
        ),
      );
    });
    core.onReconnect(() => {
      Effect.runFork(
        Effect.logInfo("MoltZap reconnected").pipe(
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
      const conversation = this.conversationsByJid.get(jid);
      if (conversation === undefined) {
        return yield* Effect.fail(
          new MoltZapChannelError({
            reason: `MoltZap channel has no taskId for jid: ${jid}`,
          }),
        );
      }
      const core = this.core;
      if (core === null) {
        return yield* Effect.fail(
          new MoltZapChannelError({
            reason: "MoltZap channel is not connected",
          }),
        );
      }
      yield* core
        .sendReply(
          conversation.taskId,
          conversation.conversationId,
          text,
          leaseId !== undefined ? { dispatchLeaseId: leaseId } : {},
        )
        .pipe(
          catchLeaseInvalid(leaseId !== undefined ? { leaseId } : undefined),
        );
      // Keep the lease entry: a second deliver for the same jid re-uses the
      // consumed lease and triggers the server's CONSUMED rejection
      // (single-use semantics).
    });
  }

  private handleInbound(enriched: EnrichedInboundMessage): void {
    // Own outbound replies echo back through the notification stream; the
    // router has no is-from-me concept, so they are dropped here.
    if (enriched.isFromMe) return;
    const config = this.setupConfig;
    if (config === null) return;
    const jid = jidFromConversationId(enriched.conversationId);
    this.rememberDispatchLease(jid, enriched);
    this.conversationsByJid.set(jid, {
      taskId: enriched.taskId,
      conversationId: enriched.conversationId,
    });
    const isGroup = enriched.conversationMeta?.type === "group";
    if (this.evalMode) {
      this.ensureEvalWiring(jid, enriched, isGroup);
    }
    config.onMetadata(jid, enriched.conversationMeta?.name, isGroup);
    // onInbound may return a promise; a rejection surfaces as a logged fiber
    // failure instead of an unhandled rejection.
    const dispatched = config.onInbound(
      jid,
      null,
      this.toInboundMessage(enriched, isGroup),
    );
    Effect.runFork(Effect.tryPromise(() => Promise.resolve(dispatched)));
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
   * Eval-mode auto-registration: harness runs create fresh conversations
   * with no pre-provisioned wiring, so the messaging group and its wiring
   * to the (single) agent group are created BEFORE the message reaches the
   * router — otherwise the router drops it. Production registrations are
   * provisioned out of band; this path stays off unless
   * `MOLTZAP_EVAL_MODE=1`.
   */
  private ensureEvalWiring(
    jid: string,
    enriched: EnrichedInboundMessage,
    isGroup: boolean,
  ): void {
    if (getMessagingGroupByPlatform(MOLTZAP_CHANNEL, jid) !== undefined) {
      return;
    }
    const agentGroup = getAllAgentGroups()[0] ?? createEvalAgentGroup();
    this.createEvalWiring(jid, enriched, isGroup, agentGroup.id);
  }

  // Engagement fields mirror the declared channel contract in
  // MOLTZAP_CONTEXT_DEFAULTS so the wiring row cannot drift from it. Row
  // ids derive from the full conversation id — the platform lookup in
  // ensureEvalWiring is then the only freshness guard needed.
  private createEvalWiring(
    jid: string,
    enriched: EnrichedInboundMessage,
    isGroup: boolean,
    agentGroupId: string,
  ): void {
    const now = new Date().toISOString();
    const shortId = enriched.conversationId.slice(0, EVAL_NAME_ID_CHARS);
    upsertUser({
      id: `${MOLTZAP_CHANNEL}:${enriched.sender.id}`,
      kind: MOLTZAP_CHANNEL,
      display_name: enriched.sender.name ?? enriched.sender.id,
      created_at: now,
    });
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
      agent_group_id: agentGroupId,
      engage_mode: MOLTZAP_CONTEXT_DEFAULTS.engageMode,
      engage_pattern: MOLTZAP_CONTEXT_DEFAULTS.engagePattern,
      sender_scope: "all",
      ignored_message_policy: "drop",
      session_mode: "shared",
      priority: 0,
      created_at: now,
    });
  }
}

export function makeMoltZapAdapter(
  env = loadMoltZapChannelEnv(),
): MoltZapAdapter | null {
  if (env.profileName === null) {
    return null;
  }
  return MoltZapAdapter.fromProfile(env.profileName, env.evalMode);
}

registerChannelAdapter(MOLTZAP_CHANNEL, {
  factory: () => makeMoltZapAdapter(),
  defaults: MOLTZAP_DEFAULTS,
});
