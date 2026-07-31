import { Effect } from "effect";
import type { Message } from "@moltzap/protocol/message";
import type { TaskId } from "@moltzap/protocol/task";
import type {
  ChannelService,
  ContextBlocks,
  EnrichedConversationMeta,
  EnrichedInboundMessage,
} from "./channel-core.js";

type CoalescedMessage = NonNullable<
  EnrichedInboundMessage["coalescedMessages"]
>[number];

interface EnrichmentContext {
  readonly conversationMeta?: EnrichedConversationMeta;
  readonly contextBlocks: ContextBlocks;
  readonly commitContext?: () => void;
}

interface EnrichedMessageInput {
  readonly service: ChannelService;
  readonly message: Message;
  readonly taskId?: TaskId;
  readonly senderName: string;
  readonly coalesced: readonly CoalescedMessage[];
  readonly context: EnrichmentContext;
}

function isMessageList(
  messageOrMessages: Message | readonly Message[],
): messageOrMessages is readonly Message[] {
  return Array.isArray(messageOrMessages);
}

function asMessageArray(
  messageOrMessages: Message | readonly Message[],
): Message[] {
  return isMessageList(messageOrMessages)
    ? [...messageOrMessages]
    : [messageOrMessages];
}

function formatCoalescedText(coalesced: readonly CoalescedMessage[]): string {
  if (coalesced.length === 1) {
    return /* Safe because the surrounding invariant establishes this asserted shape. */ coalesced[0]!
      .text;
  }
  return coalesced
    .map((message, index) =>
      index === 0
        ? message.text
        : `[queued message from ${message.sender.name} at ${message.createdAt}]\n${message.text}`,
    )
    .join("\n\n");
}

function conversationMetaFrom(
  convMeta: ReturnType<ChannelService["getConversation"]>,
): EnrichedConversationMeta | undefined {
  if (!convMeta) {
    return undefined;
  }
  return {
    type: convMeta.type === "group" ? "group" : "dm",
    name: convMeta.name,
    participants: convMeta.participants,
  };
}

function extractTextContent(parts: Message["parts"]): string {
  return parts
    .filter(
      (part): part is Extract<Message["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function resolveSenderName(
  service: ChannelService,
  agentId: string,
): Effect.Effect<string> {
  const cachedName = service.getAgentName(agentId);
  return cachedName !== undefined
    ? Effect.succeed(cachedName)
    : service.resolveAgentName(agentId);
}

function coalescedMessageFrom(
  message: Message,
  senderName: string,
): CoalescedMessage {
  return {
    id: message.id,
    sender: {
      id: message.senderId,
      name: senderName,
    },
    text: extractTextContent(message.parts),
    createdAt: message.createdAt,
  };
}

function buildCoalescedMessages(
  service: ChannelService,
  messages: readonly Message[],
  primarySenderName: string,
): Effect.Effect<CoalescedMessage[]> {
  return Effect.gen(function* () {
    const primaryMessage =
      /* Safe because the surrounding invariant establishes this asserted shape. */ messages[0]!;
    const coalesced = [coalescedMessageFrom(primaryMessage, primarySenderName)];
    for (const message of messages.slice(1)) {
      const senderName = yield* resolveSenderName(service, message.senderId);
      coalesced.push(coalescedMessageFrom(message, senderName));
    }
    return coalesced;
  });
}

function isFromOwnAgent(service: ChannelService, message: Message): boolean {
  return (
    service.ownAgentId !== undefined && message.senderId === service.ownAgentId
  );
}

function collectContextBlocks(
  service: ChannelService,
  conversationId: string,
  conversationMeta?: EnrichedConversationMeta,
): EnrichmentContext {
  const contextBlocks: ContextBlocks = {};
  if (conversationMeta?.type === "group") {
    contextBlocks.groupMetadata = conversationMeta;
  }
  const { entries, commit: commitLegacy } =
    service.peekContextEntries(conversationId);
  if (entries.length > 0) {
    contextBlocks.crossConversation = entries;
  }
  const { messages: fullMessages, commit: commitFull } =
    service.peekFullMessages(conversationId);
  if (fullMessages.length > 0) {
    contextBlocks.crossConversationMessages = fullMessages;
  }
  const hasContext = entries.length > 0 || fullMessages.length > 0;
  return {
    conversationMeta,
    contextBlocks,
    ...(hasContext
      ? {
          commitContext: () => {
            commitLegacy();
            commitFull();
          },
        }
      : {}),
  };
}

function buildEnrichedInboundMessage({
  service,
  message,
  taskId,
  senderName,
  coalesced,
  context,
}: EnrichedMessageInput): EnrichedInboundMessage {
  return {
    id: message.id,
    ...(taskId === undefined ? {} : { taskId }),
    conversationId: message.conversationId,
    sender: {
      id: message.senderId,
      name: senderName,
    },
    text: formatCoalescedText(coalesced),
    isFromMe: isFromOwnAgent(service, message),
    createdAt: message.createdAt,
    contextBlocks: context.contextBlocks,
    ...(context.conversationMeta
      ? { conversationMeta: context.conversationMeta }
      : {}),
    ...(coalesced.length > 1 ? { coalescedMessages: coalesced } : {}),
  };
}

/**
 * Executes the enrich channel message operation.
 * @param service Value supplied to the operation.
 * @param messageOrMessages Value supplied to the operation.
 * @param labels Grouping labels carried alongside the message.
 * @param labels.taskId Value supplied to the operation.
 * @returns The enrich channel message result.
 */
export function enrichChannelMessage(
  service: ChannelService,
  messageOrMessages: Message | readonly Message[],
  labels: { readonly taskId?: TaskId } = {},
): Effect.Effect<{
  enriched: EnrichedInboundMessage;
  commitContext?: () => void;
}> {
  return Effect.gen(function* () {
    const messages = asMessageArray(messageOrMessages);
    const message =
      /* Safe because the surrounding invariant establishes this asserted shape. */ messages[0]!;
    const senderName = yield* resolveSenderName(service, message.senderId);
    const coalesced = yield* buildCoalescedMessages(
      service,
      messages,
      senderName,
    );
    const conversationMeta = conversationMetaFrom(
      service.getConversation(message.conversationId),
    );
    const context = collectContextBlocks(
      service,
      message.conversationId,
      conversationMeta,
    );

    return {
      enriched: buildEnrichedInboundMessage({
        service,
        message,
        ...(labels.taskId === undefined ? {} : { taskId: labels.taskId }),
        senderName,
        coalesced,
        context,
      }),
      ...(context.commitContext
        ? { commitContext: context.commitContext }
        : {}),
    };
  }).pipe(Effect.withSpan("enrichChannelMessage"));
}
