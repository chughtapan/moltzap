/**
 * Client-side conformance barrel.
 *
 * Re-exports every client-side registrar plus the client-runner
 * primitives. Consumed by the extended `runConformanceSuite` in
 * `../suite.ts` (implement-staff scope) and by the stub entry
 * `runClientConformanceSuite` in `./suite.ts`.
 */
export {
  type ClientConformanceRunContext,
  type ClientConformanceRunOptions,
  type ObservedEvent,
  type RealClientCloseEvent,
  type RealClientEventFilter,
  type RealClientEventSubscriber,
  type RealClientHandle,
  type RealClientRpcCaller,
  type RealClientSubscription,
  ClientHandshakeWindow,
  RealClientLifecycleError,
  RealClientRpcError,
  acquireClientRunContext,
  makeClientHandshakeWindow,
} from "./runner.js";
export {
  type ClientConformanceSuiteOptions,
  type JointConformanceSuiteOptions,
  registerAllClientProperties,
  runClientConformanceSuite,
} from "./suite.js";

export {
  registerEventWellFormednessClient,
  registerMalformedFrameHandlingClient,
} from "./schema-conformance.js";
export {
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
} from "./rpc-semantics.js";
export {
  registerFanOutCardinalityClient,
  registerPayloadOpacityClient,
  registerTaskBoundaryIsolationClient,
} from "./delivery.js";
export {
  registerLatencyResilienceClient,
  registerResetPeerRecoveryClient,
  registerSlicerFramingClient,
  registerSlowCloseCleanupClient,
  registerTimeoutSurfaceClient,
} from "./adversity.js";
export { registerSchemaExhaustiveFuzzClient } from "./boundary.js";
