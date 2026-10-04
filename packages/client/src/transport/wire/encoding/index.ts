/** @file Canonical JCS bytes and the hashes, identifiers and signatures computed over them. */

/* eslint-disable jsdoc/require-jsdoc -- Re-exported private symbols retain their owning-module documentation. */

export {
  ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  representationFailure,
  sameBytes,
} from "./canonical.js";
export {
  type DecodedOuterBody,
  decodeOuterBody,
  deriveConversationId,
  deriveEvidenceMessageId,
  hashAction,
  hashAnchor,
  hashMembershipDescriptor,
  hashPostIntent,
  hashRecord,
  mintPostId,
  type OuterMembership,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
} from "./codec.js";

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
