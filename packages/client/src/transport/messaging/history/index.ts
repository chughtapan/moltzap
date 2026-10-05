/**
 * @file Certified history: the records the engine builds from its folds, and
 * the stored rows it reads back and verifies.
 */

/** Records and store rows built from an in-memory fold. */
export {
  inboundDelivery,
  makeActionCertifiedRecord,
  makeCertifiedRecord,
  protocolEvidence,
  recordAnchorHash,
  stagedRecord,
  storedCertifiedRecord,
} from "./build.js";
/** Stored rows read back, verified, and queried. */
export {
  anchorRouterInstanceId,
  decodeStoredAnchor,
  decodeStoredEvidence,
  durablePosition,
  durableRouterInstanceId,
  observedAnchorIsResolved,
  observedHeadIsResolved,
  recordFromStore,
  type StoredRowError,
  storedRowMatchesCore,
  verifyRecoveredHistory,
  verifyStoredMembership,
  verifyStoredMemberships,
  verifyStoredOutbounds,
} from "./stored.js";
/** Certificate signer order, shared with the re-anchor certificate. */
export { orderedSignatures } from "./certificate.js";
