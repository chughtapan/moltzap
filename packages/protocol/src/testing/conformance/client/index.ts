/**
 * @file Public barrel for client-side conformance runners and property registrars.
 *
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
  type ObservedNotification,
  type RealClientCloseEvent,
  type RealClientNotificationFilter,
  type RealClientNotificationSubscriber,
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
  registerAllClientProperties,
  runClientConformanceSuite,
} from "./suite.js";

export {
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
} from "./rpc-semantics.js";
export {
  registerArchiveLifecycleClient,
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
