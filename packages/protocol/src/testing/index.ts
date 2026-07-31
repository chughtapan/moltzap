/**
 * @file Public barrel for protocol testing utilities.
 *
 * `@moltzap/protocol/testing` — test fixtures, typed lifecycle clients,
 * arbitrary derivation, and Toxiproxy adversity helpers.
 */
// safer-arch-ignore no-public-test-helper-leak: The explicitly exported ./testing subpath is the supported cross-package conformance and fixture API.
// safer-arch-ignore no-public-vendor-type-leak: The ./testing entrypoint deliberately exposes fast-check arbitraries as property-test support for downstream conformance suites.

import * as arbitraries from "./arbitraries/index.js";
import * as toxics from "./toxics/index.js";

// Brand-decoders for test fixtures. Production code does not validate IDs
// at the caller.
/** Re-exports the public API from `./test-fixtures.js`. */
export {
  userId,
  agentId,
  agentName,
  appId,
  connectionId,
  contactId,
  conversationId,
  leaseId,
  messageId,
  agentKeyArbitrary,
  agentKeyString,
  agentKeyStringArbitrary,
  redactedAgentKey,
  redactedAppKey,
  taskId,
} from "./test-fixtures.js";

// Effect RPC owns frame encoding/decoding. The testing surface exposes
// descriptor-level helpers only.
/** Re-exports the public API from `#transport/descriptor`. */
export { decodeRpcResult } from "#transport/descriptor";
/** Re-exports the public API from `#task`. */
export { taskFailedNotificationDefinition } from "#task";
/** Re-exports the public API from `./wire-error-tags.js`. */
export { WIRE_ERROR_TAG } from "./wire-error-tags.js";

// Starvation-immune async-wait primitives. Shared by every package's tests so
// the parallel-flake fix (no wall-clock poll deadline) lives in one place.
/** Re-exports the public API from `./wait.js`. */
export { waitForValue, waitUntil } from "./wait.js";

/** Re-exports the public API from `./lifecycle.js`. */
export { makeTestAgentClient, makeTestAppClient } from "./lifecycle.js";
/** Re-exports the public API from `./lifecycle.js`. */
export type {
  TestAgentClient,
  TestAppClient,
  TestServer,
} from "./lifecycle.js";
/** Re-exports the public API from `./conformance/index.js`. */
export {
  runConformanceSuite,
  type ConformanceSuiteOptions,
  type SuiteResult,
} from "./conformance/index.js";
/** Re-exports the public API from `./toxics/client.js`. */
export type { ToxiproxyNetworkConfig } from "./toxics/client.js";

// Errors.
/** Re-exports the public API from `./errors.js`. */
export {
  type TestingError,
  TransportClosedError,
  TransportIoError,
  RpcTimeoutError,
  RpcResponseError,
  RealServerAcquireError,
} from "./errors.js";

// Test-agent registration helper.
/** Re-exports the public API from `./test-fixtures.js`. */
export {
  type TestAgent,
  type TestAppCredential,
  AgentRegistrationError,
  TestAppHttpRegistrationError,
  mintTestAppCredential,
  registerTestAgent,
} from "./test-fixtures.js";

// Arbitraries, toxics — namespaced to keep names scoped.
/** Re-exports the public API from `current module`. */
export { arbitraries, toxics };
