/**
 * @file Public message-domain barrel.
 */

/** Re-exports the public API from `./messages.js`. */
export {
  messagesSend,
  messagesList,
  messageReceivedNotificationDefinition,
  agentCallableMessageRpcMethods,
  messageNotifications,
  validateMessage,
  decodeMessageParts,
  decodeMessagePartsText,
  messagePartsSchema,
  validateTextPart,
} from "./messages.js";
/** Re-exports the public API from `./messages.js`. */
export type {
  Message,
  MessageParts,
  MessageReceivedNotification,
  Part,
} from "./messages.js";
