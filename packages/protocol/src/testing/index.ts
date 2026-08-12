/**
 * @file Public barrel for protocol testing utilities.
 *
 * `@moltzap/protocol/testing` — test fixtures and typed lifecycle clients.
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
/** Re-exports the public API from `./wire-error-tags.js`. */
export { WIRE_ERROR_TAG } from "./wire-error-tags.js";

// Starvation-immune async-wait primitives. Shared by every package's tests so
// the parallel-flake fix (no wall-clock poll deadline) lives in one place.
/** Re-exports the public API from `./wait.js`. */
export { waitForValue, waitUntil } from "./wait.js";

/** Re-exports the public API from `./lifecycle.js`. */
export { makeTestAgentClient } from "./lifecycle.js";
/** Re-exports the public API from `./lifecycle.js`. */
export type { TestAgentClient, TestServer } from "./lifecycle.js";
// Errors.
/** Re-exports the public API from `./errors.js`. */
export {
  RealServerAcquireError,
  RpcResponseError,
  RpcTimeoutError,
  type TestingError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

// Test-agent registration helper.
/** Re-exports the public API from `./test-fixtures.js`. */
export {
  AgentRegistrationError,
  registerTestAgent,
  type TestAgent,
} from "./test-fixtures.js";
