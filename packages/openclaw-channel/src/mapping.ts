import type { Message, EventFrame } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";

/**
 * MoltZap message -> OpenClaw InboundEnvelope mapping:
 *
 *   MoltZap                    ->  OpenClaw
 *   ------------------------------------------
 *   message.sender.type        ->  peer.kind ("user"|"bot")
 *   message.sender.id          ->  peer.id
 *   message.conversationId     ->  session context
 *   message.parts[].text       ->  text (joined with newlines)
 *   message.replyToId          ->  replyToId
 *   message.id                 ->  messageId
 */
export function mapMessageToEnvelope(
  message: Message,
  opts?: {
    senderName?: string;
    chatType?: "direct" | "group";
    groupSubject?: string;
    groupMembers?: string;
    conversationLabel?: string;
  },
) {
  return {
    channel: "moltzap" as const,
    accountId: "default",
    peer: {
      kind:
        message.sender.type === "user" ? ("user" as const) : ("bot" as const),
      id: `${message.sender.type}:${message.sender.id}`,
    },
    text: message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n"),
    conversationId: message.conversationId,
    messageId: message.id,
    replyToId: message.replyToId ?? undefined,
    ...(opts?.senderName ? { senderName: opts.senderName } : {}),
    ...(opts?.chatType ? { chatType: opts.chatType } : {}),
    ...(opts?.groupSubject ? { groupSubject: opts.groupSubject } : {}),
    ...(opts?.groupMembers ? { groupMembers: opts.groupMembers } : {}),
    ...(opts?.conversationLabel
      ? { conversationLabel: opts.conversationLabel }
      : {}),
  };
}

export function isMessageEvent(frame: EventFrame): boolean {
  return frame.event === EventNames.MessageReceived;
}

export function extractMessage(frame: EventFrame): Message | null {
  if (!isMessageEvent(frame)) return null;
  const data = frame.data as { message?: Message } | undefined;
  return data?.message ?? null;
}

// --- Event extractors for all 11 event types ---

export function extractReadReceipt(frame: EventFrame): {
  conversationId: string;
  participant: { type: string; id: string };
  seq: number;
} | null {
  if (frame.event !== EventNames.MessageRead) return null;
  const data = frame.data as
    | {
        conversationId?: string;
        participant?: { type: string; id: string };
        seq?: number;
      }
    | undefined;
  if (!data?.conversationId || !data.participant || data.seq == null)
    return null;
  return {
    conversationId: data.conversationId,
    participant: data.participant,
    seq: data.seq,
  };
}

export function extractReaction(frame: EventFrame): {
  messageId: string;
  emoji: string;
  participant: { type: string; id: string };
  action: string;
} | null {
  if (frame.event !== EventNames.MessageReacted) return null;
  const data = frame.data as
    | {
        messageId?: string;
        emoji?: string;
        participant?: { type: string; id: string };
        action?: string;
      }
    | undefined;
  if (!data?.messageId || !data.emoji || !data.participant || !data.action)
    return null;
  return {
    messageId: data.messageId,
    emoji: data.emoji,
    participant: data.participant,
    action: data.action,
  };
}

export function extractDelivery(frame: EventFrame): {
  messageId: string;
  conversationId: string;
  participant: { type: string; id: string };
} | null {
  if (frame.event !== EventNames.MessageDelivered) return null;
  const data = frame.data as
    | {
        messageId?: string;
        conversationId?: string;
        participant?: { type: string; id: string };
      }
    | undefined;
  if (!data?.messageId || !data.conversationId || !data.participant)
    return null;
  return {
    messageId: data.messageId,
    conversationId: data.conversationId,
    participant: data.participant,
  };
}

export function extractDeletion(
  frame: EventFrame,
): { messageId: string; conversationId: string } | null {
  if (frame.event !== EventNames.MessageDeleted) return null;
  const data = frame.data as
    | { messageId?: string; conversationId?: string }
    | undefined;
  if (!data?.messageId || !data.conversationId) return null;
  return { messageId: data.messageId, conversationId: data.conversationId };
}

export function extractConversationCreated(frame: EventFrame): {
  conversation: { id: string; type: string; name?: string };
} | null {
  if (frame.event !== EventNames.ConversationCreated) return null;
  const data = frame.data as
    | { conversation?: { id: string; type: string; name?: string } }
    | undefined;
  if (!data?.conversation) return null;
  return { conversation: data.conversation };
}

export function extractConversationUpdated(frame: EventFrame): {
  conversation: { id: string; type: string; name?: string };
} | null {
  if (frame.event !== EventNames.ConversationUpdated) return null;
  const data = frame.data as
    | { conversation?: { id: string; type: string; name?: string } }
    | undefined;
  if (!data?.conversation) return null;
  return { conversation: data.conversation };
}

export function extractContactRequest(frame: EventFrame): {
  contact: {
    id: string;
    requesterId: string;
    targetId: string;
    status: string;
  };
} | null {
  if (frame.event !== EventNames.ContactRequest) return null;
  const data = frame.data as
    | {
        contact?: {
          id: string;
          requesterId: string;
          targetId: string;
          status: string;
        };
      }
    | undefined;
  if (!data?.contact) return null;
  return { contact: data.contact };
}

export function extractContactAccepted(frame: EventFrame): {
  contact: {
    id: string;
    requesterId: string;
    targetId: string;
    status: string;
  };
} | null {
  if (frame.event !== EventNames.ContactAccepted) return null;
  const data = frame.data as
    | {
        contact?: {
          id: string;
          requesterId: string;
          targetId: string;
          status: string;
        };
      }
    | undefined;
  if (!data?.contact) return null;
  return { contact: data.contact };
}

export function extractPresenceChanged(frame: EventFrame): {
  participant: { type: string; id: string };
  status: string;
} | null {
  if (frame.event !== EventNames.PresenceChanged) return null;
  const data = frame.data as
    | { participant?: { type: string; id: string }; status?: string }
    | undefined;
  if (!data?.participant || !data.status) return null;
  return { participant: data.participant, status: data.status };
}

export function extractTypingIndicator(frame: EventFrame): {
  conversationId: string;
  participant: { type: string; id: string };
} | null {
  if (frame.event !== EventNames.TypingIndicator) return null;
  const data = frame.data as
    | {
        conversationId?: string;
        participant?: { type: string; id: string };
      }
    | undefined;
  if (!data?.conversationId || !data.participant) return null;
  return {
    conversationId: data.conversationId,
    participant: data.participant,
  };
}
