/** @file Core service graph composition. */
// safer-arch-ignore no-cross-domain-sibling-import: This file is the explicit composition root that wires every domain's service tags and live layers.
// safer-arch-ignore file-implicit-boundary-module: Core layers is deliberately the named internal boundary for the complete server service graph.

import { Effect, Layer } from "effect";

import { type Db, DbTag } from "#db";
import { type EnvelopeEncryption, EncryptionTag } from "#db/crypto";
import {
  connectionManagerLive,
  ConnectionManagerTag,
} from "../socket/layer.js";
import type { ConnectionManager } from "../socket/connection.js";
import {
  agentEndpointResolverLive,
  AgentEndpointResolverTag,
  networkSendServiceLive,
  NetworkSendServiceTag,
} from "../network/layer.js";
import type { AgentEndpointResolver } from "../network/agent-endpoint-resolver.js";
import type { NetworkSendService } from "../network/network-send.js";
import { authServiceLive, AuthServiceTag } from "../identity/agents/layer.js";
import type { AuthService } from "../identity/agents/auth.service.js";
import {
  appAuthServiceLive,
  AppAuthServiceTag,
  appEndpointRegistryLive,
  AppEndpointRegistryTag,
} from "../identity/apps/layer.js";
import type { AppAuthService } from "../identity/apps/auth.service.js";
import type { AppEndpointRegistry } from "../identity/apps/endpoint-registry.js";
import {
  conversationServiceLive,
  ConversationServiceTag,
} from "../conversation/layer.js";
import type { ConversationService } from "../conversation/conversation.service.js";
import { messageServiceLive, MessageServiceTag } from "../message/layer.js";
import type { MessageService } from "../message/message.service.js";

const coreRuntimeServicesLive = Layer.mergeAll(
  connectionManagerLive,
  authServiceLive,
  appAuthServiceLive,
);

const endpointResolverLive = Layer.provideMerge(
  agentEndpointResolverLive,
  coreRuntimeServicesLive,
);

const networkSendLive = Layer.provideMerge(
  networkSendServiceLive,
  endpointResolverLive,
);

const appEndpointRegistryWithNetworkLive = Layer.provideMerge(
  appEndpointRegistryLive,
  networkSendLive,
);

const conversationWithAppRegistryLive = Layer.provideMerge(
  conversationServiceLive,
  appEndpointRegistryWithNetworkLive,
);

/** Provides the services live runtime value. */
export const servicesLive = Layer.provideMerge(
  messageServiceLive,
  conversationWithAppRegistryLive,
);

/** Describes resolved services. */
export interface ResolvedServices {
  readonly db: Db;
  readonly connections: ConnectionManager;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly appAuthService: AppAuthService;
  readonly conversationService: ConversationService;
  readonly appEndpointRegistry: AppEndpointRegistry;
  readonly messageService: MessageService;
  readonly encryption: EnvelopeEncryption | null;
}

/** Provides the resolve services runtime value. */
export const resolveServices = Effect.all({
  db: DbTag,
  encryption: EncryptionTag,
  connections: ConnectionManagerTag,
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  appAuthService: AppAuthServiceTag,
  conversationService: ConversationServiceTag,
  appEndpointRegistry: AppEndpointRegistryTag,
  messageService: MessageServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
