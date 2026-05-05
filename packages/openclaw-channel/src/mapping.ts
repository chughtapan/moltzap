import { Effect, Option } from "effect";
import type {
  AnyNotificationDefinition,
  DecodedNotification,
  Message,
  NotificationFrame,
} from "@moltzap/protocol";
import {
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  MessageReceivedNotificationDefinition,
  PresenceChangedNotificationDefinition,
  decodeNotification,
  isDecodedNotification,
  notificationGroup,
} from "@moltzap/protocol";

type AnyDecodedNotification = DecodedNotification<AnyNotificationDefinition>;

function decodedNotification(
  frame: NotificationFrame,
): Option.Option<AnyDecodedNotification> {
  return Effect.runSync(
    decodeNotification(notificationGroup, frame).pipe(Effect.option),
  );
}

export function isMessageNotification(frame: NotificationFrame): boolean {
  return Option.match(decodedNotification(frame), {
    onNone: () => false,
    onSome: (notification) =>
      isDecodedNotification(
        MessageReceivedNotificationDefinition,
        notification,
      ),
  });
}

export function extractMessage(frame: NotificationFrame): Message | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isDecodedNotification(MessageReceivedNotificationDefinition, notification)
        ? notification.params.message
        : null,
  });
}

// --- Notification extractors ---

export function extractConversationCreated(frame: NotificationFrame): {
  conversation: { id: string; type: string; name?: string };
} | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isDecodedNotification(
        ConversationCreatedNotificationDefinition,
        notification,
      )
        ? { conversation: notification.params.conversation }
        : null,
  });
}

export function extractConversationUpdated(frame: NotificationFrame): {
  conversation: { id: string; type: string; name?: string };
} | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isDecodedNotification(
        ConversationUpdatedNotificationDefinition,
        notification,
      )
        ? { conversation: notification.params.conversation }
        : null,
  });
}

export function extractContactRequest(frame: NotificationFrame): {
  contact: {
    id: string;
    contactUserId: string;
  };
} | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isDecodedNotification(ContactRequestNotificationDefinition, notification)
        ? { contact: notification.params.contact }
        : null,
  });
}

export function extractContactAccepted(frame: NotificationFrame): {
  contact: {
    id: string;
    contactUserId: string;
  };
} | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isDecodedNotification(ContactAcceptedNotificationDefinition, notification)
        ? { contact: notification.params.contact }
        : null,
  });
}

export function extractPresenceChanged(frame: NotificationFrame): {
  agentId: string;
  status: string;
} | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isDecodedNotification(PresenceChangedNotificationDefinition, notification)
        ? {
            agentId: notification.params.agentId,
            status: notification.params.status,
          }
        : null,
  });
}
