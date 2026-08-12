import { Effect } from "effect";
import type {
  Conversation,
  ConversationId,
} from "@moltzap/protocol/conversation";
import type { AgentCard, AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import type {
  ChannelService,
  ContextBlocks,
  EnrichedConversationMeta,
  EnrichedInboundMessage,
} from "./channel-core.js";
import { renderPart } from "./message-rendering.js";

type CoalescedMessage = NonNullable<
  EnrichedInboundMessage["coalescedMessages"]
>[number];

interface EnrichmentContext {
  readonly conversationMeta?: EnrichedConversationMeta;
  readonly contextBlocks: ContextBlocks;
  readonly commitContext?: () => void;
}

interface ResolvedInboundMessage {
  readonly message: Message;
  readonly senderName: string;
}

type ResolvedInboundMessages = readonly [
  ResolvedInboundMessage,
  ...ResolvedInboundMessage[],
];

interface EnrichedInboundProjectionInput {
  readonly messages: ResolvedInboundMessages;
  readonly ownAgentId?: string;
  readonly conversationMeta?: EnrichedConversationMeta;
  readonly contextBlocks: ContextBlocks;
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
  resolved: ResolvedInboundMessage,
): CoalescedMessage {
  const { message, senderName } = resolved;
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

function resolveInboundMessages(
  service: ChannelService,
  messages: readonly Message[],
  primarySenderName: string,
): Effect.Effect<ResolvedInboundMessages> {
  return Effect.gen(function* () {
    const primaryMessage =
      /* Safe because the surrounding invariant establishes this asserted shape. */ messages[0]!;
    const remaining: ResolvedInboundMessage[] = [];
    for (const message of messages.slice(1)) {
      const senderName = yield* resolveSenderName(service, message.senderId);
      remaining.push({ message, senderName });
    }
    return [
      { message: primaryMessage, senderName: primarySenderName },
      ...remaining,
    ];
  });
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

/**
 * Projects a materialized nonempty message batch into the channel-owned
 * enriched shape without reading or advancing presentation state.
 * @param input Resolved messages, identity, metadata, and context blocks.
 * @returns The enriched inbound message shared by channel and harness turns.
 */
function projectEnrichedInboundMessage(
  input: EnrichedInboundProjectionInput,
): EnrichedInboundMessage {
  const primary = input.messages[0];
  const { message, senderName } = primary;
  const coalesced = input.messages.map(coalescedMessageFrom);
  return {
    id: message.id,
    conversationId: message.conversationId,
    sender: {
      id: message.senderId,
      name: senderName,
    },
    text: formatCoalescedText(coalesced),
    isFromMe:
      input.ownAgentId !== undefined && message.senderId === input.ownAgentId,
    createdAt: message.createdAt,
    contextBlocks: input.contextBlocks,
    ...(input.conversationMeta
      ? { conversationMeta: input.conversationMeta }
      : {}),
    ...(coalesced.length > 1 ? { coalescedMessages: coalesced } : {}),
  };
}

type CrossConvMessage = NonNullable<
  ContextBlocks["crossConversationMessages"]
>[number];

type ConversationWithParticipants = Conversation & {
  readonly participants: readonly AgentId[];
};

interface HarnessTurnProjectionInput {
  readonly context: {
    readonly conversations: readonly ConversationWithParticipants[];
    readonly currentMessages: readonly [Message, ...Message[]];
    readonly crossConversationMessages: readonly Message[];
  };
  readonly agents: readonly AgentCard[];
  readonly ownAgentId: AgentId;
}

const agentNamesFrom = (
  agents: readonly AgentCard[],
): ReadonlyMap<AgentId, string> =>
  new Map(agents.map((agent) => [agent.id, agent.name] as const));

const senderNameFrom = (
  names: ReadonlyMap<AgentId, string>,
  senderId: AgentId,
): string => names.get(senderId) ?? senderId;

const harnessConversationMetaFrom = (
  conversation?: ConversationWithParticipants,
): EnrichedConversationMeta | undefined =>
  conversation === undefined
    ? undefined
    : {
        type: conversation.participants.length > 2 ? "group" : "dm",
        ...(conversation.name === undefined ? {} : { name: conversation.name }),
        participants: conversation.participants.map(
          (participant) => `agent:${participant}`,
        ),
      };

const renderMessageText = (message: Message): string =>
  message.parts.map(renderPart).join(" ");

const crossConversationMessagesFrom = (
  messages: readonly Message[],
  conversations: ReadonlyMap<ConversationId, ConversationWithParticipants>,
  agentNames: ReadonlyMap<AgentId, string>,
): readonly CrossConvMessage[] =>
  messages.map((message) => {
    const conversationName = conversations.get(message.conversationId)?.name;
    return {
      conversationId: message.conversationId,
      ...(conversationName === undefined ? {} : { conversationName }),
      senderName: senderNameFrom(agentNames, message.senderId),
      senderId: message.senderId,
      text: renderMessageText(message),
      timestamp: message.createdAt,
    };
  });

/**
 * Projects MCP-reconstructed context into the channel-owned enriched shape.
 * @param input Reconstructed messages plus resolved identity information.
 * @param input.context Current and cross-conversation message context.
 * @param input.agents Agent cards used for presentation names.
 * @param input.ownAgentId Active identity used to mark self-authored content.
 * @returns The enriched inbound message exposed by a harness turn.
 */
export const projectHarnessTurn = ({
  context,
  agents,
  ownAgentId,
}: HarnessTurnProjectionInput): EnrichedInboundMessage => {
  const agentNames = agentNamesFrom(agents);
  const conversations = new Map(
    context.conversations.map(
      (conversation) => [conversation.id, conversation] as const,
    ),
  );
  const [primary, ...remaining] = context.currentMessages;
  const resolvedMessages: ResolvedInboundMessages = [
    {
      message: primary,
      senderName: senderNameFrom(agentNames, primary.senderId),
    },
    ...remaining.map((message) => ({
      message,
      senderName: senderNameFrom(agentNames, message.senderId),
    })),
  ];
  const conversationMeta = harnessConversationMetaFrom(
    conversations.get(primary.conversationId),
  );
  const crossConversationMessages = crossConversationMessagesFrom(
    context.crossConversationMessages,
    conversations,
    agentNames,
  );
  const contextBlocks: ContextBlocks = {
    ...(conversationMeta?.type === "group"
      ? { groupMetadata: conversationMeta }
      : {}),
    ...(crossConversationMessages.length === 0
      ? {}
      : { crossConversationMessages: [...crossConversationMessages] }),
  };

  return projectEnrichedInboundMessage({
    messages: resolvedMessages,
    ownAgentId,
    ...(conversationMeta === undefined ? {} : { conversationMeta }),
    contextBlocks,
  });
};

/**
 * Executes the enrich channel message operation.
 * @param service Value supplied to the operation.
 * @param messageOrMessages Value supplied to the operation.
 * @returns The enrich channel message result.
 */
export function enrichChannelMessage(
  service: ChannelService,
  messageOrMessages: Message | readonly Message[],
): Effect.Effect<{
  enriched: EnrichedInboundMessage;
  commitContext?: () => void;
}> {
  return Effect.gen(function* () {
    const messages = asMessageArray(messageOrMessages);
    const message =
      /* Safe because the surrounding invariant establishes this asserted shape. */ messages[0]!;
    const senderName = yield* resolveSenderName(service, message.senderId);
    const resolvedMessages = yield* resolveInboundMessages(
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
      enriched: projectEnrichedInboundMessage({
        messages: resolvedMessages,
        ...(service.ownAgentId === undefined
          ? {}
          : { ownAgentId: service.ownAgentId }),
        ...(context.conversationMeta === undefined
          ? {}
          : { conversationMeta: context.conversationMeta }),
        contextBlocks: context.contextBlocks,
      }),
      ...(context.commitContext
        ? { commitContext: context.commitContext }
        : {}),
    };
  }).pipe(Effect.withSpan("enrichChannelMessage"));
}
