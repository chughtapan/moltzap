/** @file Core service graph composition. */
// safer-arch-ignore no-cross-domain-sibling-import: This file is the explicit composition root that wires every domain's service tags and live layers.
// safer-arch-ignore file-implicit-boundary-module: The core index is the named internal boundary for the complete server service graph.

import { Effect, Layer } from "effect";

import { type Db, DbTag } from "#db";
import {
  type AgentEndpointResolver,
  agentEndpointResolverLive,
  AgentEndpointResolverTag,
  type NetworkSendService,
  networkSendServiceLive,
  NetworkSendServiceTag,
} from "#network";
import {
  type ConversationService,
  conversationServiceLive,
  ConversationServiceTag,
} from "../conversation/conversation.service.js";
import {
  type AuthService,
  authServiceLive,
  AuthServiceTag,
} from "../identity/agents/auth.service.js";
import {
  type MessageService,
  messageServiceLive,
  MessageServiceTag,
} from "../message/message.service.js";
import {
  type ConnectionManager,
  connectionManagerLive,
  ConnectionManagerTag,
} from "../socket/connection.js";

const coreRuntimeServicesLive = Layer.mergeAll(
  connectionManagerLive,
  authServiceLive,
);

const endpointResolverLive = Layer.provideMerge(
  agentEndpointResolverLive,
  coreRuntimeServicesLive,
);

const networkSendLive = Layer.provideMerge(
  networkSendServiceLive,
  endpointResolverLive,
);

const conversationWithNetworkLive = Layer.provideMerge(
  conversationServiceLive,
  networkSendLive,
);

/** Provides the services live runtime value. */
export const servicesLive = Layer.provideMerge(
  messageServiceLive,
  conversationWithNetworkLive,
);

/** Describes resolved services. */
export interface ResolvedServices {
  readonly db: Db;
  readonly connections: ConnectionManager;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly conversationService: ConversationService;
  readonly messageService: MessageService;
}

/** Provides the resolve services runtime value. */
export const resolveServices = Effect.all({
  db: DbTag,
  connections: ConnectionManagerTag,
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  conversationService: ConversationServiceTag,
  messageService: MessageServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
