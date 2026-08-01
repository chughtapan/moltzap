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
export {
  agentId,
  agentKeyArbitrary,
  agentKeyString,
  agentKeyStringArbitrary,
  appId,
  connectionId,
  contactId,
  conversationId,
  leaseId,
  messageId,
  redactedAgentKey,
  redactedAppKey,
  taskId,
  userId,
} from "./test-fixtures.js";

// Effect RPC owns frame encoding/decoding. The testing surface exposes
// descriptor-level helpers only.
export { decodeRpcResult } from "#transport/descriptor";
export { TaskFailedNotificationDefinition } from "#task";
export { WIRE_ERROR_TAG } from "./wire-error-tags.js";

// Starvation-immune async-wait primitives. Shared by every package's tests so
// the parallel-flake fix (no wall-clock poll deadline) lives in one place.
export { waitForValue, waitUntil } from "./wait.js";

export { makeTestAgentClient, makeTestAppClient } from "./lifecycle.js";
export type {
  TestAgentClient,
  TestAppClient,
  TestServer,
} from "./lifecycle.js";
export {
  type ConformanceSuiteOptions,
  runConformanceSuite,
  type SuiteResult,
} from "./conformance/index.js";
export type { ToxiproxyNetworkConfig } from "./toxics/client.js";

// Errors.
export {
  RealServerAcquireError,
  RpcResponseError,
  RpcTimeoutError,
  type TestingError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

// Test-agent registration helper.
export {
  AgentRegistrationError,
  mintTestAppCredential,
  registerTestAgent,
  type TestAgent,
  type TestAppCredential,
  TestAppHttpRegistrationError,
} from "./test-fixtures.js";

// Arbitraries, toxics — namespaced to keep names scoped.
export { arbitraries, toxics };
