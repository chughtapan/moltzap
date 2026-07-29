/**
 * @file Public message-domain barrel.
 */

export {
  MessageNotFoundError,
  MessagesSend,
  MessagesList,
  MessagesAuthorize,
  MessageReceivedNotificationDefinition,
  agentCallableMessageRpcMethods,
  messageCallbackMethods,
  messageNotifications,
  DispatchDecisionSchema,
  validateDispatchDecision,
  validateMessage,
  decodeMessageParts,
  decodeMessagePartsText,
  messagePartsSchema,
  validateTextPart,
} from "./messages.js";
export type {
  DispatchDecision,
  Message,
  MessageParts,
  MessageReceivedNotification,
  Part,
} from "./messages.js";
