import { MoltZapService } from "@moltzap/client";
import type { Message } from "@moltzap/protocol";

import type { Channel, NewMessage, RegisteredGroup } from "../types.js";
import { logger } from "../logger.js";
import { registerChannel, type ChannelOpts } from "./registry.js";

const MOLTZAP_JID_PREFIX = "mz:";
const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";

export interface ContextAdapterConfig {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}

export interface ConversationMetaLike {
  type: string;
  name?: string;
  participants?: string[];
}

export interface MoltZapServiceLike {
  on(event: "message", handler: (msg: Message) => void): void;
  on(event: "disconnect", handler: () => void): void;
  on(event: "reconnect", handler: () => void): void;
  connect(): Promise<unknown>;
  close(): void;
  send(conversationId: string, text: string): Promise<void>;
  getConversation(convId: string): ConversationMetaLike | undefined;
  getAgentName(agentId: string): string | undefined;
  resolveAgentName(agentId: string): Promise<string>;
  getContext(convId: string, opts: ContextAdapterConfig): string | null;
  readonly ownAgentId: string | undefined;
}

function jidFromConversationId(conversationId: string): string {
  return `${MOLTZAP_JID_PREFIX}${conversationId}`;
}

function conversationIdFromJid(jid: string): string {
  return jid.slice(MOLTZAP_JID_PREFIX.length);
}

function extractTextContent(parts: Message["parts"]): string {
  return parts
    .filter(
      (p): p is Extract<Message["parts"][number], { type: "text" }> =>
        p.type === "text",
    )
    .map((p) => p.text)
    .join("\n");
}

function buildGroupContextBlock(convMeta: ConversationMetaLike): string {
  const participants = convMeta.participants ?? [];
  const lines = [
    "<system-reminder>",
    "This is a group conversation.",
    `Group name: ${convMeta.name ?? "(unnamed)"}`,
    `Participants (${participants.length}): ${participants.join(", ") || "(none listed)"}`,
    "</system-reminder>",
  ];
  return lines.join("\n");
}

export class MoltZapChannel implements Channel {
  readonly name = "moltzap";
  private connected = false;
  private dispatchChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: ChannelOpts,
    private readonly service: MoltZapServiceLike,
    private readonly evalMode: boolean = false,
    private readonly contextAdapter?: ContextAdapterConfig,
  ) {
    this.service.on("message", (message) => {
      this.dispatchChain = this.dispatchChain
        .then(() => this.handleInboundMessage(message))
        .catch((err) => {
          logger.error(
            { channel: "moltzap", messageId: message.id, err },
            "Failed to handle inbound MoltZap message",
          );
        });
    });

    this.service.on("disconnect", () => {
      this.connected = false;
      logger.warn({ channel: "moltzap" }, "MoltZap disconnected");
    });

    this.service.on("reconnect", () => {
      this.connected = true;
      logger.info({ channel: "moltzap" }, "MoltZap reconnected");
    });
  }

  async connect(): Promise<void> {
    await this.service.connect();
    this.connected = true;
    logger.info({ channel: "moltzap" }, "MoltZap connected");
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`MoltZap channel does not own jid: ${jid}`);
    }
    const conversationId = conversationIdFromJid(jid);
    await this.service.send(conversationId, text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MOLTZAP_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.service.close();
    this.connected = false;
  }

  private async handleInboundMessage(message: Message): Promise<void> {
    const chatJid = jidFromConversationId(message.conversationId);
    const convMeta = this.service.getConversation(message.conversationId);

    // SMOKE-TEST ONLY: in MOLTZAP_EVAL_MODE, auto-register previously-unknown
    // conversations as nanoclaw groups so nanoclaw routes subsequent messages
    // to the agent without a human running `setup register`. This exists to
    // bridge the eval-runtime-starts-before-conversations-exist lifecycle
    // mismatch. Delete when extracting the stable runtime-adapter interface.
    if (this.evalMode) {
      const registered = this.opts.registeredGroups();
      if (!registered[chatJid]) {
        const stubGroup: RegisteredGroup = {
          name: `eval-${message.conversationId.slice(0, 8)}`,
          folder: `eval_${message.conversationId.slice(0, 8)}`,
          trigger: ".*",
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: true,
        };
        // Mutate the registered groups map in place. Nanoclaw's setter isn't
        // exposed through ChannelOpts, but the map returned by
        // registeredGroups() is the live one in 1.2.52; this is a known
        // coupling to the internal shape, accepted for smoke test.
        registered[chatJid] = stubGroup;
      }
    }

    this.opts.onChatMetadata(
      chatJid,
      message.createdAt,
      convMeta?.name,
      "moltzap",
      convMeta?.type === "group",
    );

    const senderName =
      this.service.getAgentName(message.sender.id) ??
      (await this.service
        .resolveAgentName(message.sender.id)
        .catch(() => message.sender.id));

    const rawContent = extractTextContent(message.parts);

    // Context enrichment: prepend system-reminder blocks ahead of the raw
    // message text. Nanoclaw's router formats NewMessage.content verbatim into
    // the prompt XML, so this lands in front of the agent with no upstream
    // changes. Cross-conversation context is opt-in (contextAdapter config);
    // group metadata is always attached when the conversation is a group.
    const contextBlocks: string[] = [];
    if (this.contextAdapter) {
      const crossConv = this.service.getContext(
        message.conversationId,
        this.contextAdapter,
      );
      if (crossConv) contextBlocks.push(crossConv);
    }
    if (convMeta?.type === "group") {
      contextBlocks.push(buildGroupContextBlock(convMeta));
    }
    const content =
      contextBlocks.length > 0
        ? `${contextBlocks.join("\n\n")}\n\n${rawContent}`
        : rawContent;

    const isFromMe =
      this.service.ownAgentId !== undefined &&
      message.sender.id === this.service.ownAgentId;

    const nanoclawMessage: NewMessage = {
      id: message.id,
      chat_jid: chatJid,
      sender: message.sender.id,
      sender_name: senderName,
      content,
      timestamp: message.createdAt,
      is_from_me: isFromMe,
      reply_to_message_id: message.replyToId,
    };

    logger.debug(
      {
        channel: "moltzap",
        messageId: message.id,
        from: senderName,
        conv: message.conversationId,
      },
      "MoltZap inbound message",
    );

    this.opts.onMessage(chatJid, nanoclawMessage);
  }
}

registerChannel("moltzap", (opts: ChannelOpts): Channel | null => {
  const apiKey = process.env.MOLTZAP_API_KEY;
  const serverUrl = process.env.MOLTZAP_SERVER_URL ?? DEFAULT_SERVER_URL;
  const evalMode = process.env.MOLTZAP_EVAL_MODE === "1";
  const contextAdapter: ContextAdapterConfig | undefined =
    process.env.MOLTZAP_CONTEXT_ADAPTER === "cross-conversation"
      ? { type: "cross-conversation" }
      : undefined;

  if (!apiKey) {
    return null;
  }

  const service = new MoltZapService({
    serverUrl,
    agentKey: apiKey,
    logger: {
      info: (...args: unknown[]) =>
        logger.info({ channel: "moltzap" }, args.map(String).join(" ")),
      warn: (...args: unknown[]) =>
        logger.warn({ channel: "moltzap" }, args.map(String).join(" ")),
      error: (...args: unknown[]) =>
        logger.error({ channel: "moltzap" }, args.map(String).join(" ")),
    },
  });

  return new MoltZapChannel(opts, service, evalMode, contextAdapter);
});
