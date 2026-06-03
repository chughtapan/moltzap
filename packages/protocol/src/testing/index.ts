/**
 * @file Public barrel for protocol testing utilities.
 *
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
  appId,
  connectionId,
  contactId,
  conversationId,
  leaseId,
  messageId,
  taskId,
} from "./conformance/_shared/test-fixtures.js";

// Wire-frame builders + schemas + validators + the protocol literal, and the
// group-level decoders — exposed ONLY for test use. Production builds frames via
// the live transport and decodes via `decodeServerInbound`, never these raw
// constructors/decoders; the conformance harness + test scaffolds use them to
// assemble frames (valid and adversarial) and exercise the codec/decoder
// boundary properties. This `/testing` barrel is the single sanctioned
// re-export of these wire internals — test code imports them from here, never
// by reaching `wire.js` / `rpc-groups.js` / `method.js`.
export {
  requestFrame,
  responseFrame,
  notificationFrame,
  requestFrameSchema,
  responseFrameSchema,
  notificationFrameSchema,
  validateRequestFrame,
  validateResponseFrame,
  validateNotificationFrame,
  JSON_RPC_VERSION,
} from "../transport/wire.js";
export {
  decodeRpcRequest,
  decodeNotification,
} from "../transport/rpc-groups.js";
export { decodeRpcResult } from "../transport/method.js";
export type { JsonRpcMethod } from "../transport/wire.js";
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
