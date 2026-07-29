/**
 * @file Public message-domain barrel.
 */

/** Re-exports the public API from `./messages.js`. */
export {
  MessageNotFoundError,
  messagesSend,
  messagesList,
  messagesAuthorize,
  messageReceivedNotificationDefinition,
  agentCallableMessageRpcMethods,
  messageCallbackMethods,
  messageNotifications,
  validateDispatchDecision,
  validateMessage,
  decodeMessageParts,
  decodeMessagePartsText,
  validateTextPart,
} from "./messages.js";
/** Re-exports the public API from `./messages.js`. */
export type {
  DispatchDecision,
  Message,
  MessageReceivedNotification,
  Part,
} from "./messages.js";
