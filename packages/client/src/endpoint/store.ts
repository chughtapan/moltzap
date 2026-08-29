/** @file Private typed facade for one daemon-owned endpoint store. */

/** Closed error value and scoped store acquisition. */
export { EndpointStoreError, openEndpointStore } from "./store/index.js";
/** Closed non-diagnostic persistence failure categories. */
export type { EndpointStoreFailure } from "./store/database/index.js";
/** Canonical private DTOs and the EndpointStore capability. */
export type {
  CertifiedRecord,
  CompletedReanchor,
  ConversationFoundation,
  ConversationPage,
  ConversationPosition,
  DisseminationKind,
  DisseminationObligation,
  EmptyConversationRestart,
  EndpointRecovery,
  EndpointStore,
  HistoryPage,
  IdentityBinding,
  InboundDeliveryInput,
  OutboundAttempt,
  OutboundMessageInput,
  PendingDelivery,
  PostIntent,
  PostIntentBinding,
  ProposalLock,
  ProtocolEvidence,
  RecoveredReanchor,
  RestartedEmptyConversation,
  StagedReanchor,
  StagedRecord,
  StoredAnchor,
  StoredMembership,
  StoredOutboundMessage,
  StoreMutation,
} from "./store/types.js";
/** Stable opaque durable-delivery identity. */
export { DeliveryToken } from "./store/types.js";
