/**
 * `@moltzap/protocol/testing` — TestClient + TestServer primitives,
 * reference model, arbitrary derivation, Toxiproxy adversity layer, and
 * the five-tier conformance runner.
 *
 * Subpath export wiring lives in `packages/protocol/package.json` and is
 * added by the implement-staff modality (architect charter forbids
 * `package.json` edits in the stub PR).
 */

// Primitives.
export {
  type TestClient,
  type TestClientConfig,
  makeTestClient,
} from "./test-client.js";
export {
  type TestServer,
  type TestServerConfig,
  type TestServerConnection,
  makeTestServer,
} from "./test-server.js";

// Capture + codec primitives.
export {
  type CaptureBuffer,
  type CapturedFrame,
  type CaptureKind,
  makeCaptureBuffer,
  mergeCaptures,
  recordFrame,
  recordMalformed,
} from "./captures.js";
export {
  type AnyFrame,
  type MalformedFrameKind,
  encodeFrame,
  decodeFrame,
  malformFrame,
} from "./codec.js";

// Errors.
export {
  type TestingError,
  TransportClosedError,
  TransportIoError,
  FrameSchemaError,
  RpcTimeoutError,
  RpcResponseError,
  ToxicControlError,
  RealServerAcquireError,
} from "./errors.js";

// Test-agent registration helper.
export {
  type TestAgent,
  AgentRegistrationError,
  registerTestAgent,
} from "./agent-registration.js";

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
  type WebhookAdapterProbe,
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
