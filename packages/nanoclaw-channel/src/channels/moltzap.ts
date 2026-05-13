import { Config, ConfigProvider, Data, Effect, Option, Redacted } from "effect";
import { RpcServerError } from "@moltzap/protocol";
import {
  MoltZapChannelCore,
  MoltZapService,
  sanitizeForSystemReminder,
  type CrossConvMessage,
  type EnrichedConversationMeta,
  type EnrichedInboundMessage,
  type ServiceRpcError,
  type WsClientLogger,
} from "@moltzap/client";

const EVAL_GROUP_NAME_ID_CHARS = 8;

import type { Channel } from "../types.js";
import { logger } from "../logger.js";
import { registerChannel, type ChannelOpts } from "./registry.js";

/**
 * Format cross-conversation messages using nanoclaw's native XML `&lt;message>`
 * structure (matching the upstream `formatMessages()` in router.ts), wrapped
 * in `&lt;system-reminder>` for containment. Adds a `conversation` attribute
 * to identify the source conversation.
 */
function formatCrossConvNanoclaw(
  messages: CrossConvMessage[],
  opts: { ownAgentId: string },
): string {
  const lines = messages.map((m) => {
    const sender = sanitizeForSystemReminder(
      m.senderId === opts.ownAgentId ? "You" : m.senderName,
    );
    const conv = sanitizeForSystemReminder(
      m.conversationName ?? `DM with @${m.senderName}`,
    );
    const text = sanitizeForSystemReminder(m.text);
    const time = sanitizeForSystemReminder(m.timestamp);
    return `<message sender="${sender}" conversation="${conv}" time="${time}">${text}</message>`;
  });
  return ["<messages>", ...lines, "</messages>"].join("\n");
}

const MOLTZAP_JID_PREFIX = "mz:";
const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";
const MoltZapChannelEnv = Config.all({
  apiKey: Config.option(Config.redacted("MOLTZAP_API_KEY")),
  serverUrl: Config.string("MOLTZAP_SERVER_URL").pipe(
    Config.withDefault(DEFAULT_SERVER_URL),
  ),
  evalMode: Config.string("MOLTZAP_EVAL_MODE").pipe(Config.withDefault("0")),
});

class MoltZapChannelError extends Data.TaggedError("MoltZapChannelError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

function jidFromConversationId(conversationId: string): string {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
}

function conversationIdFromJid(jid: string): string {
  return jid.slice(MOLTZAP_JID_PREFIX.length);
}

function loadMoltZapChannelEnv(): {
  readonly apiKey: string | undefined;
  readonly serverUrl: string;
  readonly evalMode: boolean;
} {
  const env = Effect.runSync(
    MoltZapChannelEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
  return {
    apiKey: Option.match(env.apiKey, {
      onNone: () => undefined,
      onSome: Redacted.value,
    }),
    serverUrl: env.serverUrl,
    evalMode: env.evalMode === "1",
  };
}

// Nanoclaw's router consumes NewMessage.content verbatim into prompt XML,
// so structured context blocks are rendered as <system-reminder> markup here.

function formatGroupBlock(meta: EnrichedConversationMeta): string {
  const safeName = sanitizeForSystemReminder(meta.name ?? "(unnamed)");
  const safeParticipants = meta.participants.map(sanitizeForSystemReminder);
  return [
    "<system-reminder>",
    "This is a group conversation.",
    `Group name: ${safeName}`,
    `Participants (${meta.participants.length}): ${safeParticipants.join(", ") || "(none listed)"}`,
    "</system-reminder>",
  ].join("\n");
}

export class MoltZapChannel implements Channel {
  readonly name = "moltzap";
  private readonly dispatchLeasesByJid = new Map<string, string>();

  constructor(
    private readonly opts: ChannelOpts,
    private readonly core: MoltZapChannelCore,
    private readonly ownAgentId: string,
    private readonly evalMode: boolean = false,
  ) {
    core.onInbound((msg) => Effect.sync(() => this.handleInbound(msg)));
    core.onDisconnect(() => {
      logger.warn({ channel: "moltzap" }, "MoltZap disconnected");
    });
    core.onReconnect(() => {
      logger.info({ channel: "moltzap" }, "MoltZap reconnected");
    });
  }

  connect() {
    // `core.connect()` is already an Effect — just run it at the nanoclaw
    // Channel boundary, which imposes a Promise contract.
    return Effect.runPromise(
      this.core
        .connect()
        .pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              logger.info({ channel: "moltzap" }, "MoltZap connected"),
            ),
          ),
        ),
    );
  }

  /**
   * Outbound reply path. Cutover #533 — single-use lease semantics:
   * the FIRST send consumes the lease via `core.sendReply`. Any
   * subsequent send for the same JID within the same dispatch finds
   * the entry STILL in the map (we no longer delete it eagerly) AND
   * the lease in `CONSUMED` state server-side; the typed
   * `RpcServerError(data.reason="LeaseInvalid")` propagates as
   * `MoltZapChannelError({reason: "lease already consumed"})` to
   * nanoclaw.
   *
   * Pre-cutover behaviour deleted the entry after the first send,
   * which on a second send would silently fall back to an unleased
   * `core.sendReply` — server side accepts it (no lease binding) but
   * the moderator has no observability of the second message. The
   * post-cutover surface is uniform.
   */
  sendMessage(jid: string, text: string) {
    return Effect.runPromise(
      Effect.gen(this, function* () {
        if (!this.ownsJid(jid)) {
          return yield* Effect.fail(
            new MoltZapChannelError({
              reason: `MoltZap channel does not own jid: ${jid}`,
            }),
          );
        }
        const leaseId = this.dispatchLeasesByJid.get(jid);
        yield* this.core
          .sendReply(
            conversationIdFromJid(jid),
            text,
            leaseId !== undefined ? { dispatchLeaseId: leaseId } : {},
          )
          .pipe(
            Effect.mapError(
              (err: ServiceRpcError): ServiceRpcError | MoltZapChannelError => {
                if (
                  err instanceof RpcServerError &&
                  typeof err.data === "object" &&
                  err.data !== null &&
                  (err.data as { reason?: unknown }).reason === "LeaseInvalid"
                ) {
                  return new MoltZapChannelError({
                    reason: "lease already consumed",
                  });
                }
                return err;
              },
            ),
          );
        // Keep the lease entry: a second sendMessage for the same
        // JID re-uses the consumed lease and triggers the server's
        // CONSUMED rejection (single-use semantics).
      }),
    );
  }

  isConnected(): boolean {
    return this.core.isConnected();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MOLTZAP_JID_PREFIX);
  }

  disconnect() {
    // `core.disconnect()` is an Effect that never fails.
    return Effect.runPromise(this.core.disconnect());
  }

  private handleInbound(enriched: EnrichedInboundMessage): void {
    const chatJid = jidFromConversationId(enriched.conversationId);
    if (enriched.dispatchLeaseId) {
      this.dispatchLeasesByJid.set(chatJid, enriched.dispatchLeaseId);
    }

    // SMOKE-TEST ONLY: auto-register unknown convs in MOLTZAP_EVAL_MODE.
    // Remove when the runtime-adapter interface lands.
    if (this.evalMode) {
      this.ensureAutoRegistered(chatJid, enriched.conversationId);
    }

    this.opts.onChatMetadata(
      chatJid,
      enriched.createdAt,
      enriched.conversationMeta?.name,
      "moltzap",
      enriched.conversationMeta?.type === "group",
    );

    const blocks: string[] = [];
    if (enriched.contextBlocks.crossConversationMessages?.length) {
      blocks.push(
        formatCrossConvNanoclaw(
          enriched.contextBlocks.crossConversationMessages,
          { ownAgentId: this.ownAgentId },
        ),
      );
    }
    if (enriched.contextBlocks.groupMetadata) {
      blocks.push(formatGroupBlock(enriched.contextBlocks.groupMetadata));
    }
    const content =
      blocks.length > 0
        ? `${blocks.join("\n\n")}\n\n${enriched.text}`
        : enriched.text;

    this.opts.onMessage(chatJid, {
      id: enriched.id,
      chat_jid: chatJid,
      sender: enriched.sender.id,
      sender_name: enriched.sender.name ?? enriched.sender.id,
      content,
      timestamp: enriched.createdAt,
      is_from_me: enriched.isFromMe,
      reply_to_message_id: enriched.replyToId,
    });
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

registerChannel("moltzap", (opts: ChannelOpts): Channel | null => {
  const { apiKey, serverUrl, evalMode } = loadMoltZapChannelEnv();

  if (!apiKey) return null;

  const wsLogger: WsClientLogger = {
    info: (...args) =>
      logger.info({ channel: "moltzap" }, args.map(String).join(" ")),
    warn: (...args) =>
      logger.warn({ channel: "moltzap" }, args.map(String).join(" ")),
    error: (...args) =>
      logger.error({ channel: "moltzap" }, args.map(String).join(" ")),
  };

  const service = new MoltZapService({
    serverUrl,
    agentKey: apiKey,
    logger: wsLogger,
  });

  const core = new MoltZapChannelCore({ service, logger: wsLogger });

  return new MoltZapChannel(opts, core, service.ownAgentId ?? "", evalMode);
});
