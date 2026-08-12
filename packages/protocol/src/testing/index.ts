/**
 * @file Public barrel for protocol testing utilities.
 *
 * `@moltzap/protocol/testing` — test fixtures and assertion helpers.
 */

// safer-arch-ignore no-public-test-helper-leak: The explicitly exported ./testing subpath is the supported cross-package fixture API.
// safer-arch-ignore no-public-vendor-type-leak: The ./testing entrypoint deliberately exposes FastCheck-backed agent-key generators as test support.

// Brand-decoders for test fixtures. Production code does not validate IDs
// at the caller.
/** Re-exports the public API from `./test-fixtures.js`. */
export {
  agentId,
  agentKeyArbitrary,
  agentKeyString,
  agentKeyStringArbitrary,
  agentName,
  connectionId,
  conversationId,
  messageId,
  redactedAgentKey,
  userId,
} from "./test-fixtures.js";

// Effect RPC owns frame encoding/decoding. The testing surface exposes
// descriptor-level helpers only.
/** Re-exports the public API from `#transport/descriptor`. */
export { decodeRpcResult } from "#transport/descriptor";
