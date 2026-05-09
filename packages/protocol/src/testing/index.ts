/**
 * `@moltzap/protocol/testing` — TestClient + TestServer primitives,
 * reference model, arbitrary derivation, Toxiproxy adversity layer, and
 * the five-tier conformance runner.
 *
 * Subpath export wiring lives in `packages/protocol/package.json` and is
 * added by the implement-staff modality (architect charter forbids
 * `package.json` edits in the stub PR).
 */

// Brand-decoders for test fixtures. Production code does not validate IDs
// at the caller.
export {
  userId,
  agentId,
  contactId,
  conversationId,
  messageId,
  taskId,
} from "./conformance/_shared/test-fixtures.js";

// Wire-frame validators + protocol literal exposed only for test use.
export {
  validateRequestFrame,
  validateResponseFrame,
  JSON_RPC_VERSION,
} from "../transport/wire.js";
export type { JsonRpcMethod } from "../transport/wire.js";
export { wireErrorFromInstance } from "../transport/json-rpc-server.js";
export { TaskFailedNotificationDefinition } from "../task/methods.js";

// Primitives.
export {
  type CloseableTestClient,
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

// Capture + codec primitives.
export {
  type CaptureBuffer,
  type CapturedFrame,
  type CaptureKind,
  makeCaptureBuffer,
  mergeCaptures,
  recordFrame,
  recordMalformed,
} from "./conformance/_shared/captures.js";
export {
  type AnyFrame,
  type MalformedFrameKind,
  encodeFrame,
  decodeFrame,
  malformFrame,
} from "./conformance/_shared/frame-mutator.js";

// Errors.
export {
  type TestingError,
  TransportClosedError,
  TransportIoError,
  RpcTimeoutError,
  RpcResponseError,
  RealServerAcquireError,
} from "./conformance/_shared/errors.js";
export { FrameSchemaError } from "./conformance/_shared/frame-mutator.js";
export { ToxicControlError } from "./toxics/errors.js";

// Test-agent registration helper.
export {
  type TestAgent,
  AgentRegistrationError,
  registerTestAgent,
} from "./conformance/_shared/test-fixtures.js";

// Arbitraries, models, toxics — namespaced to keep names scoped.
export * as arbitraries from "./arbitraries/index.js";
export * as models from "./models/index.js";
export * as toxics from "./toxics/index.js";

// Conformance suite — top-level so consumers can write
// `import { runConformanceSuite } from "@moltzap/protocol/testing";`
// without having to reach into a namespace.
export {
  type ConformanceArtifact,
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
  acquireRunContext,
  assertProperty,
  collectProperties,
  registerAllProperties,
  registerProperty,
  runAllProperties,
  runConformance,
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
export type {
  ClientConformanceSuiteOptions,
  JointConformanceSuiteOptions,
} from "./conformance/client/suite.js";
