/**
 * @file Public barrel for protocol testing utilities.
 *
 * `@moltzap/protocol/testing` — test fixtures, arbitrary derivation,
 * Toxiproxy adversity layer, and the conformance runner.
 */

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
  taskId,
} from "./conformance/_shared/test-fixtures.js";

// Effect RPC owns frame encoding/decoding. The testing surface exposes
// descriptor-level helpers only.
export { decodeRpcResult } from "../transport/method.js";
export type { JsonRpcMethod } from "../transport/method.js";
export { TaskFailedNotificationDefinition } from "../task/index.js";
export { WIRE_ERROR_TAG } from "./wire-error-tags.js";

// Primitives.
export {
  ServerRequestWaitError,
  type CloseableTestClient,
  type ServerRpcContext,
  type ServerRpcDefinition,
  type ServerRpcParams,
  type ServerRpcResult,
  type TestClient,
  type TestClientConfig,
  makeCloseableTestClient,
  makeTestClient,
} from "./conformance/_shared/driver/index.js";
export {
  type TestServer,
  type TestServerConfig,
  type TestServerConnection,
  makeTestServer,
} from "./conformance/_shared/driver/index.js";

// Starvation-immune async-wait primitives. Shared by every package's tests so
// the parallel-flake fix (no wall-clock poll deadline) lives in one place.
export { waitForValue, waitUntil } from "./wait.js";

// Capture primitives.
export {
  type CaptureBuffer,
  type CapturedFrame,
  type CaptureKind,
  makeCaptureBuffer,
  mergeCaptures,
  recordFrame,
  recordMalformed,
} from "./conformance/_shared/captures.js";

// Errors.
export {
  type TestingError,
  TransportClosedError,
  TransportIoError,
  RpcTimeoutError,
  RpcResponseError,
  RealServerAcquireError,
} from "./conformance/_shared/errors.js";
export { ToxicControlError } from "./toxics/errors.js";

// Test-agent registration helper.
export {
  type TestAgent,
  AgentRegistrationError,
  registerTestAgent,
} from "./conformance/_shared/test-fixtures.js";
export {
  type RegisterTestAppOptions,
  type TestApp,
  type TestAppCallbackHandler,
  type TestAppCallbackScript,
  type TestAppManifestOptions,
  type TestAppRegistrationFailure,
  makeTestAppManifest,
  registerTestApp,
} from "./conformance/_shared/test-app.js";

// Arbitraries, toxics — namespaced to keep names scoped.
export * as arbitraries from "./arbitraries/index.js";
export * as toxics from "./toxics/index.js";

// Conformance suite — top-level so consumers can write
// `import { runConformanceSuite } from "@moltzap/protocol/testing";`
// without having to reach into a namespace.
export {
  type ConformanceRunContext,
  type ConformanceRunOptions,
  type ConformanceSuiteOptions,
  type PropertyCategory,
  type PropertyFailure,
  type PropertyRun,
  type RealServerHandle,
  type RegisteredProperty,
  type SuiteResult,
  PropertyAssertionFailure,
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  assertProperty,
  collectProperties,
  registerAllProperties,
  registerProperty,
  runAllProperties,
  runConformanceSuite,
} from "./conformance/index.js";

// Individual category modules under a namespace for consumers who want
// to register a subset of properties.
export * as conformance from "./conformance/index.js";

// Client-side conformance surface (architect arch-201; spec amendment
// #200). The `clientConformance` namespace carries the factory types
// (`RealClientHandle`, `RealClientRpcError`), the dedicated entry
// `runClientConformanceSuite`, and every `register*Client` registrar.
export * as clientConformance from "./conformance/client/index.js";

// Top-level type re-exports so consumer wrappers (packages/client,
// openclaw-channel, nanoclaw-channel) can `import type {
// RealClientHandle, ... } from "@moltzap/protocol/testing"`.
export type {
  ClientConformanceRunContext,
  ClientConformanceRunOptions,
  ObservedNotification,
  RealClientCloseEvent,
  RealClientNotificationFilter,
  RealClientNotificationSubscriber,
  RealClientFactoryArgs,
  RealClientHandle,
  RealClientRpcCaller,
  RealClientSubscription,
} from "./conformance/client/runner.js";
export {
  RealClientLifecycleError,
  RealClientRpcError,
} from "./conformance/client/runner.js";
export type { ClientConformanceSuiteOptions } from "./conformance/client/suite.js";
