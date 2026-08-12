import type { NotificationDelivery } from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordOrEmpty = (value: unknown): Record<string, unknown> =>
  isPlainRecord(value) ? value : {};

const recordProperty = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record[key];
  return isPlainRecord(value) ? value : undefined;
};

const stringProperty = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const traceConversationId = (
  conversation?: Record<string, unknown>,
  fallback?: string,
): unknown =>
  conversation === undefined ? fallback : (conversation.id ?? fallback);

/**
 * Builds the stable diagnostic projection for one inbound notification.
 * @param notification Notification delivered by the active socket client.
 * @param agentId Agent receiving the notification when identity is available.
 * @returns A JSON-safe trace record.
 */
export function notificationTraceRecord(
  notification: NotificationDelivery<AnyNotificationDefinition>,
  agentId?: string,
): Record<string, unknown> {
  const params = recordOrEmpty(notification.params);
  const message = recordProperty(params, "message");
  const conversation = recordProperty(params, "conversation");
  const notificationConversationId = stringProperty(params, "conversationId");
  return {
    ts: new Date().toISOString(),
    agentId: agentId ?? "unknown",
    notification: notification.method,
    messageId: message?.id,
    messageConversationId: message?.conversationId,
    messageSenderId: message?.senderId,
    conversationId: traceConversationId(
      conversation,
      notificationConversationId,
    ),
    conversationName: conversation?.name,
  };
}
