/**
 * @file Public Identity contracts: immutable agent cards, identifiers,
 * signing, and request authentication. Identity sits at the root of the
 * product dependency graph and imports no other workspace package.
 */
// safer-arch-ignore no-folder-cycle: This facade re-exports cohesive identity modules that depend on sibling identity contracts; those modules never import the facade.

/**
 * The sole MoltZap wire compatibility value. Every MoltZap-owned network
 * schema carries exactly this value; there is no range negotiation or
 * per-layer wire version. `version.ts` is its source of truth: the
 * architecture boundary check reads the literal from there, and
 * `scripts/docs/moltzap-version.ts` reads it for the documentation
 * constants generator and its gate tests.
 *
 * The npm package version, the MCP revision, simulator definition ID,
 * EventCatalog schema, and RunLedger storage version are independent
 * namespaces and never imply compatibility with this value.
 */
export { MOLTZAP_VERSION } from "./version.js";

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
  MessageId,
  SignedMessage,
  SignedMessageSigningError,
  SignedMessageVerificationError,
  type VerifiedSignedMessage,
} from "./signed-message.js";
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
