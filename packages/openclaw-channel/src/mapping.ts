import { Data, Effect, Option } from "effect";
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
  decodeServerInbound,
} from "@moltzap/protocol";

type AnyDecodedNotification = DecodedNotification<AnyNotificationDefinition>;

class NotANotificationFrameError extends Data.TaggedError(
  "NotANotificationFrameError",
)<{ readonly tag: string }> {}

function decodedNotification(
  frame: NotificationFrame,
): Option.Option<AnyDecodedNotification> {
  return Effect.runSync(
    decodeServerInbound(frame).pipe(
      Effect.flatMap((decoded) =>
        decoded._tag === "Notification"
          ? Effect.succeed(decoded as AnyDecodedNotification)
          : Effect.fail(new NotANotificationFrameError({ tag: decoded._tag })),
      ),
      Effect.option,
    ),
  );
}

/** Discriminate a decoded notification by descriptor identity. Cheaper
 * than a structural check; the descriptor is the unique nominal token. */
const isFor = <D extends AnyNotificationDefinition>(
  notification: AnyDecodedNotification,
  definition: D,
): notification is DecodedNotification<D> =>
  notification.definition === definition;

export function isMessageNotification(frame: NotificationFrame): boolean {
  return Option.match(decodedNotification(frame), {
    onNone: () => false,
    onSome: (notification) =>
      isFor(notification, MessageReceivedNotificationDefinition),
  });
}

export function extractMessage(frame: NotificationFrame): Message | null {
  return Option.match(decodedNotification(frame), {
    onNone: () => null,
    onSome: (notification) =>
      isFor(notification, MessageReceivedNotificationDefinition)
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
      isFor(notification, ConversationCreatedNotificationDefinition)
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
      isFor(notification, ConversationUpdatedNotificationDefinition)
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
      isFor(notification, ContactRequestNotificationDefinition)
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
      isFor(notification, ContactAcceptedNotificationDefinition)
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
      isFor(notification, PresenceChangedNotificationDefinition)
        ? {
            agentId: notification.params.agentId,
            status: notification.params.status,
          }
        : null,
  });
}
