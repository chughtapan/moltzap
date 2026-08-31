/** @file Simulator network contracts and run-scoped services. */
// safer-arch-ignore no-inventory-barrel: The Network subpath deliberately exposes the complete contract implemented by these five domain modules.

/** Re-exports nominal participant identity handles. */
export {
  AgentHandle,
  makeAgentHandle,
  makeParticipantHandle,
  ParticipantHandle,
} from "./participant.js";
/** Re-exports controlled endpoint contracts. */
export {
  Endpoint,
  type EndpointInbox,
  makeEndpoint,
  Network,
  type NetworkService,
} from "./endpoint.js";
/** Re-exports typed simulator network failures. */
export {
  NetworkError,
  networkError,
  type NetworkOperation,
} from "./failure.js";
/** Re-exports Router fixture acquisition and lifecycle contracts. */
export {
  type AgentConnection,
  type AttachedEndpoint,
  type EndpointTransport,
  makeRouterStopReport,
  type ParticipantIds,
  type Router,
  RouterProvider,
  type RouterProviderService,
  RouterStopped,
} from "./router.js";
/** Re-exports directed-link fault-control contracts. */
export {
  type InboundLinkStage,
  LinkController,
  type LinkControllerService,
  type LinkDelivery,
  LinkDriver,
  type LinkDriverService,
  linkPolicy,
  type LinkPolicy,
  type LinkPolicyLease,
  linkVerdict,
  type LinkVerdict,
} from "./link.js";
