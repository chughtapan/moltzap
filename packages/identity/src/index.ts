/**
 * @file Public Identity contracts: immutable agent cards, identifiers,
 * signing, sealed message bodies, and request authentication. Identity sits
 * at the root of the product dependency graph and imports no other workspace
 * package.
 */
// safer-arch-ignore no-folder-cycle: This facade re-exports cohesive identity modules that depend on sibling identity contracts; those modules never import the facade.

/** Emission and admission share one wire namespace, independent of npm and MCP. */
export {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
  type WireVersion,
} from "./version.js";
/** Compatibility operations have no injectable context tag in the published API. */
export { wireVersions } from "./wire-versions.js";

/** Canonical refined values shared by identity and its consumers. */
export { AgentId, AgentName, PrincipalId } from "./identifiers.js";
/** Exact immutable public-key representation used by identity artifacts. */
export {
  AgentSigningAuthority,
  Ed25519PublicKey,
  InvalidAgentPrivateKeyError,
} from "./agent-key.js";
/** Immutable Registry attestation and its pinned verification boundary. */
export {
  AgentCard,
  AgentCardDigest,
  AgentCardVerificationError,
  type VerifiedAgentCard,
} from "./agent-card.js";
/** Opaque attributed payload and endpoint-owned signing operations. */
export {
  type LiveSignedMessage,
  MessageId,
  SignedMessage,
  SignedMessageSigningError,
  SignedMessageVerificationError,
  type VerifiedSignedMessage,
} from "./signed-message.js";
/** End-to-end sealed SignedMessage bodies and their closed failures. */
export {
  SealedBody,
  SealedBodyOpeningError,
  SealedBodySealingError,
} from "./sealed-body.js";
/** Registered-agent HTTP authentication and its opaque verified proof. */
export {
  AuthenticatedHttp,
  type VerifiedAgentRequest,
} from "./authenticated-http.js";
/** Shared closed HTTP-envelope failures. */
export {
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "./http-errors.js";
/** HTTP request signing failure without implementation detail. */
export { AgentSigningError } from "./http-signature.js";

/** Configuration refusals share one prefix rule across all service processes. */
export { legacyKeys } from "./legacy-keys.js";
