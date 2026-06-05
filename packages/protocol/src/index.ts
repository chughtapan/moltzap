/**
 * @file Protocol package root.
 *
 * Transitional compatibility surface while the protocol package is rebalanced.
 * The final root target is the runtime lifecycle surface; descriptor and schema
 * exports are already available on focused subpaths.
 */

export { MoltZapAgentClient } from "./agent-client.js";
export { MoltZapAppClient } from "./app-client.js";
export { MoltZapServer } from "./server-lifecycle.js";

export type { AgentClientOptions } from "./agent-client.js";
export type { AppCallbackContext, AppClientOptions } from "./app-client.js";
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
} from "./server-lifecycle.js";

export { RPC_TIMEOUT_MS } from "./client-lifecycle.js";
export type {
  ClientDefinitionError,
  ClientDefinitionPayload,
  ClientDefinitionSuccess,
  ClientRpcDefinition,
  RpcCallOptions,
} from "./client-lifecycle.js";

export {
  classifyCloseCause,
  DEFAULT_ABNORMAL_CLOSE,
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
} from "./close-info.js";
export type { CloseInfo, CloseKind } from "./close-info.js";

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
} from "./runtime/connection.js";

export {
  ConversationId,
  LeaseId,
  MessageId,
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
  ConversationArchivedError,
  ConversationFullError,
  ConversationNotFoundError,
  MessageNotFoundError,
  NotAParticipantError,
  HookBlockedError,
  ParticipantNotAdmittedError,
  MessagesSend,
  MessagesList,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  AppId,
  DEFAULT_APP_ID,
  TaskRequest,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  validateDispatchDecision,
  dispatchDecisionSchema,
  messageWithDispatchDecisionSchema,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
} from "./task/index.js";
export type {
  TaskReadAccessValue,
  ConversationInTaskValue,
  ConversationSendAccessValue,
  ContactPolicyAllowsReachValue,
  Part,
  Message,
  Conversation,
  ConversationParticipant,
  ConversationSummary,
  TaskStatus,
  Task,
  TaskParticipant,
  MessageReceivedNotification,
  DispatchDecision,
  MessageWithDispatchDecision,
  InitialConversationInput,
  TaskConversationListItem,
  TaskConversationCreatedNotification,
  TaskConversationArchivedNotification,
  TaskConversationUnarchivedNotification,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
} from "./task/index.js";

export {
  DispatchId,
  DispatchRequest,
  DispatchAuthorize,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  MessagesAuthorize,
  TaskCreate,
  validateAppManifest,
  DispatchNotFoundError,
} from "./app/index.js";
export type {
  AppCallbackHandlers,
  AppCallbackRpcDefinition,
  AppManifest,
  HandlerSlot,
} from "./app/index.js";

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
