/**
 * @file Public identity contracts: immutable agent cards, identifiers,
 * and the signing and request-authentication profiles every other v2
 * package builds on. `identity` sits at the root of the v2 dependency
 * graph and imports no other v2 package.
 */
// safer-arch-ignore no-folder-cycle: This public facade exposes Registry while its implementation depends on package-owned identity contracts; implementation modules never import this facade.

/**
 * The sole MoltZap compatibility value. Every MoltZap-owned network
 * schema and all six v2 package manifests carry exactly this value;
 * there is no range negotiation and no per-layer version. `v2/VERSION`
 * is its source of truth, and a boundary check fails the build when the
 * two drift.
 *
 * The MCP revision, simulator definition ID, EventCatalog schema, and
 * RunLedger storage version are independent namespaces and never imply
 * compatibility with this value.
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
/** Closed Registry request Schemas and verified capability result types. */
export {
  OperationId,
  RegistryListRequest,
  RegistryLookupRequest,
  RegistryRegisterRequest,
  type RegistryListResult,
  type RegistryLookupResult,
  type RegistryRegisterResult,
} from "./registry/contract.js";
/** Registry client capability and closed infrastructure failures. */
export {
  Registry,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryRequestTimeoutError,
} from "./registry.js";
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
