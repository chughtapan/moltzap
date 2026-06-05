/**
 * @file Protocol package root.
 *
 * Transitional compatibility surface while the protocol package is rebalanced.
 * The final root target is the socket lifecycle surface; descriptor and schema
 * exports are already available on focused subpaths.
 */

export { MoltZapAgentClient } from "./socket/agent-client.js";
export { MoltZapAppClient } from "./socket/app-client.js";
export { MoltZapServer } from "./socket/server.js";

export type { AgentClientOptions } from "./socket/agent-client.js";
export type {
  AppCallbackContext,
  AppClientOptions,
} from "./socket/app-client.js";
export type {
  MoltZapServerOptions,
  MoltZapServerSession,
  ReverseCallError,
  ReverseCallbackError,
  ReverseCallbackPayload,
  ReverseCallbackSuccess,
  ReverseCallbackTag,
  ReverseCallbackRequest,
  ReverseClient,
  ServerSocketWrite,
} from "./socket/server.js";

export { RPC_TIMEOUT_MS } from "./socket/lifecycle.js";
export type {
  ClientDefinitionError,
  ClientDefinitionPayload,
  ClientDefinitionSuccess,
  ClientRpcDefinition,
  RpcCallOptions,
} from "./socket/lifecycle.js";

export {
  classifyCloseCause,
  DEFAULT_ABNORMAL_CLOSE,
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
} from "./socket/close-info.js";
export type { CloseInfo, CloseKind } from "./socket/close-info.js";

export {
  AgentKey,
  AppKey,
  InviteCode,
  RegistrationSecret,
  ServerEncryptionMasterSecret,
} from "./credentials.js";

export {
  effectiveErrorClasses,
  jsonRpcMethod,
  isNotificationDeliveryFor,
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
  dispatchCall,
  makeTypedTransportCall,
  NotConnectedError,
  RpcTimeoutError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidParamsError,
  AlreadyConnected,
  principalGateErrorClasses,
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
  AgentClaimed,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  ListLimitSchema,
  listCursorSchema,
} from "./transport/index.js";
export type { BrandedString } from "./transport/wire-string.js";
export type {
  RpcDefinition,
  NotificationDefinition,
  ParamsOf,
  ResultOf,
  NotificationParamsOf,
  NotificationDelivery,
  RpcErrorClass,
  CallErrorsOf,
  DomainErrorsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
  NotificationSubscriberRegistry,
  NotificationSubscriberRegistryOptions,
  NotificationSubscriptionHandle,
  TypedDispatchMap,
  RpcForTag,
  PayloadForTag,
  SuccessForTag,
  ErrorForTag,
  RpcErrorPayload,
  PrincipalRequirement,
  ListCursor,
} from "./transport/index.js";

export {
  AgentId,
  ContactId,
  UserId,
  Register,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
  AgentNotFoundError,
} from "./identity/index.js";
export type { Agent, AgentCard, Contact } from "./identity/index.js";

export {
  AgentConnect,
  AppConnect,
  PROTOCOL_VERSION,
  compareProtocolVersion,
  checkProtocolRange,
  PresenceSubscribe,
  PresenceChangedNotificationDefinition,
  ProtocolMismatchError,
  InvalidProtocolVersionError,
  agentCallableNetworkRpcMethods,
  appCallableNetworkRpcMethods,
  sharedNetworkRpcMethods,
  networkRpcMethods,
} from "./network/index.js";
export type { HelloOk, ProtocolMismatchReason } from "./network/index.js";

export {
  ConnectionId,
  connectionId,
  newConnectionId,
} from "./socket/connection.js";

export {
  TaskId,
  TaskReadAccess,
  ConversationInTask,
  ConversationSendAccess,
  ContactPolicyAllowsReach,
  assertAppOwnsTask,
  assertConversationInTaskMatches,
  assertTaskReadAccessMatchesTask,
  TaskClosedError,
  TaskNotFoundError,
  TaskRejectedError,
  HookBlockedError,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  AppId,
  DEFAULT_APP_ID,
  TaskRequest,
  TaskCreate,
  TaskLeave,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
  taskCallbackMethods,
} from "./task/index.js";
export type {
  TaskReadAccessValue,
  ConversationInTaskValue,
  ConversationSendAccessValue,
  ContactPolicyAllowsReachValue,
  TaskStatus,
  Task,
  TaskParticipant,
  InitialConversationInput,
} from "./task/index.js";

export {
  ConversationArchivedError,
  ConversationFullError,
  ConversationId,
  ConversationNotFoundError,
  MessageId,
  NotAParticipantError,
  ParticipantNotAdmittedError,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "./conversation/index.js";
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
  TaskConversationListItem,
  TaskConversationCreatedNotification,
  TaskConversationArchivedNotification,
  TaskConversationUnarchivedNotification,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
} from "./conversation/index.js";

export {
  DispatchNotFoundError,
  LeaseId,
  MessageNotFoundError,
  MessageReceivedNotificationDefinition,
  MessagesAuthorize,
  MessagesList,
  MessagesSend,
  messageCallbackMethods,
  dispatchDecisionSchema,
  messagePartsSchema,
  messageWithDispatchDecisionSchema,
  validateDispatchDecision,
} from "./message/index.js";
export type {
  DispatchDecision,
  Message,
  MessageReceivedNotification,
  MessageWithDispatchDecision,
  Part,
} from "./message/index.js";

export {
  DispatchId,
  DispatchRequest,
  DispatchAuthorize,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  dispatchCallbackMethods,
} from "./dispatch/index.js";

export { validateAppManifest } from "./app/index.js";
export type { AppManifest } from "./app/index.js";
export type {
  AppCallbackHandlers,
  AppCallbackRpcDefinition,
  HandlerSlot,
} from "./socket/index.js";

export {
  NotificationRpcGroup,
  ReverseRpcGroup,
  AgentCallableGroup,
  AppCallableGroup,
  agentCallableMethods,
  appCallableMethods,
  serverInboundMethods,
  notificationDefinitions,
  appCallbackMethods,
} from "./rpc-method-groups.js";
export type {
  AnyServerRpcDefinition,
  AnyAgentCallableRpcDefinition,
  AnyAppCallableRpcDefinition,
  AnyAppCallbackRpcDefinition,
  AnyNotificationDefinition,
} from "./rpc-method-groups.js";

export {
  principalRequirementOf,
  requiresClaimed,
  middlewaresForRequirements,
} from "./requirements.js";
export type {
  Principal,
  Requirement,
  CapabilityRequirement,
  PrincipalRequirementOf,
  MwStackFor,
} from "./requirements.js";
