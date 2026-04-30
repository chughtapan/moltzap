import { Effect } from "effect";
import {
  MoltZapChannelCore,
  MoltZapService,
  sanitizeForSystemReminder,
  type CrossConvMessage,
  type EnrichedConversationMeta,
  type EnrichedInboundMessage,
  type WsClientLogger,
} from "@moltzap/client";

import type { Channel } from "../types.js";
import { logger } from "../logger.js";
import { registerChannel, type ChannelOpts } from "./registry.js";

/**
 * Format cross-conversation messages using nanoclaw's native XML `<message>`
 * structure (matching the upstream `formatMessages()` in router.ts), wrapped
 * in `<system-reminder>` for containment. Adds a `conversation` attribute
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

function jidFromConversationId(conversationId: string): string {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
}

function conversationIdFromJid(jid: string): string {
  return jid.slice(MOLTZAP_JID_PREFIX.length);
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

  // #ignore-sloppy-code-next-line[async-keyword, promise-type]: nanoclaw Channel interface contract
  async connect(): Promise<void> {
    // `core.connect()` is already an Effect — just run it at the nanoclaw
    // Channel boundary, which imposes a Promise contract.
    await Effect.runPromise(
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

  // #ignore-sloppy-code-next-line[async-keyword, promise-type]: nanoclaw Channel interface contract
  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`MoltZap channel does not own jid: ${jid}`);
    }
    await Effect.runPromise(
      this.core.sendReply(conversationIdFromJid(jid), text, {
        dispatchLeaseId: this.dispatchLeasesByJid.get(jid),
      }),
    );
    this.dispatchLeasesByJid.delete(jid);
  }

  isConnected(): boolean {
    return this.core.isConnected();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MOLTZAP_JID_PREFIX);
  }

  // #ignore-sloppy-code-next-line[async-keyword, promise-type]: nanoclaw Channel interface contract
  async disconnect(): Promise<void> {
    // `core.disconnect()` is an Effect that never fails.
    await Effect.runPromise(this.core.disconnect());
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
      name: `eval-${conversationId.slice(0, 8)}`,
      folder: `eval_${conversationId.slice(0, 8)}`,
      trigger: ".*",
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    };
  }
}

registerChannel("moltzap", (opts: ChannelOpts): Channel | null => {
  const apiKey = process.env.MOLTZAP_API_KEY;
  const serverUrl = process.env.MOLTZAP_SERVER_URL ?? DEFAULT_SERVER_URL;
  const evalMode = process.env.MOLTZAP_EVAL_MODE === "1";

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
