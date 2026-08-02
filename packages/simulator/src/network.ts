/** @file Network contracts and run-scoped Effect services. */

/** Re-exports the public API from `./network/participant.js`. */
export {
  AgentHandle,
  ParticipantHandle,
  makeAgentHandle,
  makeParticipantHandle,
} from "./network/participant.js";
/** Re-exports the public API from `./network/conversation.js`. */
export {
  ConversationAddress,
  ConversationSocket,
  type ConversationParticipants,
} from "./network/conversation.js";
/** Re-exports the public API from `./network/endpoint.js`. */
export {
  Endpoint,
  Network,
  makeEndpoint,
  type EndpointInbox,
  type NetworkService,
} from "./network/endpoint.js";
/** Re-exports the public API from `./network/router.js`. */
export {
  CommittedRouterMessage,
  NetworkFailure,
  type RouterSequence,
  RouterProvider,
  RouterStopped,
  makeRouterStopReport,
  networkFailure,
  routerSequence,
  type AgentConnection,
  type AttachedEndpoint,
  type EndpointTransport,
  type MessageParts,
  type NetworkOperation,
  type OpenedConversation,
  type ParticipantIds,
  type ReceivedMessage,
  type Router,
  type RouterProviderService,
} from "./network/router.js";
/** Re-exports the public API from `./network/link.js`. */
export {
  LinkController,
  LinkDriver,
  linkPolicy,
  linkVerdict,
  type InboundLinkStage,
  type LinkControllerService,
  type LinkDelivery,
  type LinkDriverService,
  type LinkPolicy,
  type LinkPolicyLease,
  type LinkVerdict,
} from "./network/link.js";
