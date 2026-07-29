/** @file Network contracts and run-scoped Effect services. */

export {
  AgentHandle,
  ParticipantHandle,
  makeAgentHandle,
  makeParticipantHandle,
} from "./network/participant.js";
export {
  ConversationAddress,
  ConversationSocket,
  type ConversationParticipants,
} from "./network/conversation.js";
export {
  Endpoint,
  Network,
  makeEndpoint,
  type EndpointInbox,
  type NetworkService,
} from "./network/endpoint.js";
export {
  CommittedRouterMessage,
  NetworkFailure,
  RouterSequence,
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
export {
  LinkController,
  LinkDriver,
  type LinkControllerService,
  type LinkDriverService,
} from "./network/link.js";
