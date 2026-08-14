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
  EndpointRecovery,
  EndpointStore,
  HistoryPage,
  IdentityBinding,
  ProtocolEvidence,
  RecoveredReanchor,
  StagedReanchor,
  StagedRecord,
  StartIntent,
  StoredAnchor,
  StoredMembership,
  StoreMutation,
} from "./store/types.js";
