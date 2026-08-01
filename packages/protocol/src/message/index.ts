/**
 * @file Public message-domain barrel.
 */

/** Re-exports the public API from `./messages.js`. */
export {
  messagesSend,
  messagesList,
  messagesAuthorize,
  HookBlockedError,
  messageReceivedNotificationDefinition,
  agentCallableMessageRpcMethods,
  messageCallbackMethods,
  messageNotifications,
  dispatchDecisionSchema,
  validateDispatchDecision,
  validateMessage,
  decodeMessageParts,
  decodeMessagePartsText,
  messagePartsSchema,
  validateTextPart,
} from "./messages.js";
/** Re-exports the public API from `./messages.js`. */
export type {
  DispatchDecision,
  Message,
  MessageParts,
  MessageReceivedNotification,
  Part,
} from "./messages.js";
