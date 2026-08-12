/**
 * @file Public barrel for protocol testing utilities.
 *
 * `@moltzap/protocol/testing` — test fixture constructors.
 */

// safer-arch-ignore no-public-test-helper-leak: The explicitly exported ./testing subpath is the supported cross-package fixture API.

// Brand-decoders for test fixtures. Production code does not validate IDs
// at the caller.
/** Re-exports the public API from `./test-fixtures.js`. */
export {
  agentId,
  agentKeyString,
  agentName,
  conversationId,
  messageId,
  redactedAgentKey,
  userId,
} from "./test-fixtures.js";
