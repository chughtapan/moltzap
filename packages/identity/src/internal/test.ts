/** @file Test-only wire overrides and adversarial representation fixtures. */
/** Injectable release policy is available only with the test condition. */
export { WireVersions } from "../wire-versions.js";
/** Fixtures construct exact and intentionally malformed wire requests. */
export { encodeCanonicalJson } from "../canonical-json.js";
/** Fixtures sign deliberately invalid requests without weakening production signing. */
export { contentDigest } from "../http-signature.js";
/** Fixtures construct signatures outside the production authority boundary. */
export {
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
} from "../agent-key.js";
