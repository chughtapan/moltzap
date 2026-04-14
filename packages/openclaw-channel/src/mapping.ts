import type { Message, EventFrame } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";

export function isMessageEvent(frame: EventFrame): boolean {
  return frame.event === EventNames.MessageReceived;
}

export function extractMessage(frame: EventFrame): Message | null {
  if (!isMessageEvent(frame)) return null;
  const data = frame.data as { message?: Message } | undefined;
  return data?.message ?? null;
}

// --- Event extractors ---

export function extractReaction(frame: EventFrame): {
  messageId: string;
  emoji: string;
  agentId: string;
  action: string;
} | null {
  if (frame.event !== EventNames.MessageReacted) return null;
  const data = frame.data as
    | {
        messageId?: string;
        emoji?: string;
        agentId?: string;
        action?: string;
      }
    | undefined;
  if (!data?.messageId || !data.emoji || !data.agentId || !data.action)
    return null;
  return {
    messageId: data.messageId,
    emoji: data.emoji,
    agentId: data.agentId,
    action: data.action,
  };
}

export function extractDelivery(frame: EventFrame): {
  messageId: string;
  conversationId: string;
  agentId: string;
} | null {
  if (frame.event !== EventNames.MessageDelivered) return null;
  const data = frame.data as
    | {
        messageId?: string;
        conversationId?: string;
        agentId?: string;
      }
    | undefined;
  if (!data?.messageId || !data.conversationId || !data.agentId) return null;
  return {
    messageId: data.messageId,
    conversationId: data.conversationId,
    agentId: data.agentId,
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
    contactUserId: string;
    source: string;
  };
} | null {
  if (frame.event !== EventNames.ContactRequest) return null;
  const data = frame.data as
    | {
        contact?: {
          id: string;
          contactUserId: string;
          source: string;
        };
      }
    | undefined;
  if (!data?.contact) return null;
  return { contact: data.contact };
}

export function extractContactAccepted(frame: EventFrame): {
  contact: {
    id: string;
    contactUserId: string;
    source: string;
  };
} | null {
  if (frame.event !== EventNames.ContactAccepted) return null;
  const data = frame.data as
    | {
        contact?: {
          id: string;
          contactUserId: string;
          source: string;
        };
      }
    | undefined;
  if (!data?.contact) return null;
  return { contact: data.contact };
}

export function extractPresenceChanged(frame: EventFrame): {
  agentId: string;
  status: string;
} | null {
  if (frame.event !== EventNames.PresenceChanged) return null;
  const data = frame.data as { agentId?: string; status?: string } | undefined;
  if (!data?.agentId || !data.status) return null;
  return { agentId: data.agentId, status: data.status };
}
