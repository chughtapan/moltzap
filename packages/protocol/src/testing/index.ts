/**
 * @file Public barrel for protocol testing utilities.
 *
 * `@moltzap/protocol/testing` — test fixtures, typed lifecycle clients,
 * arbitrary derivation, and Toxiproxy adversity helpers.
 */
import * as arbitraries from "./arbitraries/index.js";
import * as toxics from "./toxics/index.js";

// Brand-decoders for test fixtures. Production code does not validate IDs
// at the caller.
export {
  userId,
  agentId,
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
  redactedRegistrationSecret,
  redactedServerEncryptionMasterSecret,
  taskId,
} from "./test-fixtures.js";

// Effect RPC owns frame encoding/decoding. The testing surface exposes
// descriptor-level helpers only.
export { decodeRpcResult } from "../transport/method.js";
export { TaskFailedNotificationDefinition } from "../task/index.js";
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
  runConformanceSuite,
  type ConformanceSuiteOptions,
  type SuiteResult,
} from "./conformance/index.js";
export type { ToxiproxyNetworkConfig } from "./toxics/client.js";

// Errors.
export {
  type TestingError,
  TransportClosedError,
  TransportIoError,
  RpcTimeoutError,
  RpcResponseError,
  RealServerAcquireError,
} from "./errors.js";

// Test-agent registration helper.
export {
  type TestAgent,
  type TestAppCredential,
  AgentRegistrationError,
  TestAppHttpRegistrationError,
  mintTestAppCredential,
  registerTestAgent,
} from "./test-fixtures.js";

// Arbitraries, toxics — namespaced to keep names scoped.
export { arbitraries, toxics };
