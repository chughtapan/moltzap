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
} from "./errors.js";

// Arbitraries, models, toxics, conformance.
export * as arbitraries from "./arbitraries/index.js";
export * as models from "./models/index.js";
export * as toxics from "./toxics/index.js";
export * as conformance from "./conformance/index.js";
