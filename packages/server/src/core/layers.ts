/** @file Core service graph composition. */

import { Effect, Layer } from "effect";

import type { Db } from "#db";
import type { EnvelopeEncryption } from "#db/crypto";
import {
  ConnectionManagerLive,
  ConnectionManagerTag,
  type ConnectionManager,
} from "#socket";
import {
  AgentEndpointResolverLive,
  AgentEndpointResolverTag,
  NetworkSendServiceLive,
  NetworkSendServiceTag,
  type AgentEndpointResolver,
  type NetworkSendService,
} from "#network";
import {
  AuthServiceLive,
  AuthServiceTag,
  type AuthService,
} from "#identity/agents";
import {
  AppAuthServiceLive,
  AppAuthServiceTag,
  AppEndpointRegistryLive,
  AppEndpointRegistryTag,
  type AppAuthService,
  type AppEndpointRegistry,
} from "#identity/apps";
import {
  ContactsServiceLive,
  ContactsServiceTag,
  type ContactsService,
} from "#identity/contacts";
import {
  ConversationServiceLive,
  ConversationServiceTag,
  type ConversationService,
} from "#conversation";
import {
  PresenceServiceLive,
  PresenceServiceTag,
  type PresenceService,
} from "#network/presence";
import {
  DispatchAdmissionServiceLive,
  LeaseRegistryLive,
  LeaseRegistryTag,
  type LeaseRegistry,
} from "#dispatch";
import {
  MessageAuthorizationServiceLive,
  MessageServiceLive,
  MessageServiceTag,
  type MessageService,
} from "#message";
import {
  TaskAuthorizationServiceLive,
  TaskServiceLive,
  TaskServiceTag,
  type TaskService,
} from "#task";
import { DbTag } from "#db";
import { EncryptionTag } from "#db/crypto";

const CoreRuntimeServicesLive = Layer.mergeAll(
  ConnectionManagerLive,
  AuthServiceLive,
  AppAuthServiceLive,
  ContactsServiceLive,
);

const PresenceAndEndpointResolverLive = Layer.provideMerge(
  Layer.mergeAll(PresenceServiceLive, AgentEndpointResolverLive),
  CoreRuntimeServicesLive,
);

const NetworkSendWithPresenceLive = Layer.provideMerge(
  NetworkSendServiceLive,
  PresenceAndEndpointResolverLive,
);

const LeaseRegistryWithNetworkLive = Layer.provideMerge(
  LeaseRegistryLive,
  NetworkSendWithPresenceLive,
);

const AppEndpointRegistryWithLeasesLive = Layer.provideMerge(
  AppEndpointRegistryLive,
  LeaseRegistryWithNetworkLive,
);

const ConversationWithAppRegistryLive = Layer.provideMerge(
  ConversationServiceLive,
  AppEndpointRegistryWithLeasesLive,
);

const DomainAuthorizationLive = Layer.provideMerge(
  Layer.mergeAll(
    DispatchAdmissionServiceLive,
    MessageAuthorizationServiceLive,
    TaskAuthorizationServiceLive,
  ),
  ConversationWithAppRegistryLive,
);

const MessageDomainLive = Layer.provideMerge(
  MessageServiceLive,
  DomainAuthorizationLive,
);

export const ServicesLive = Layer.provideMerge(
  TaskServiceLive,
  MessageDomainLive,
);

export interface ResolvedServices {
  readonly db: Db;
  readonly connections: ConnectionManager;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly appAuthService: AppAuthService;
  readonly conversationService: ConversationService;
  readonly contactService: ContactsService;
  readonly presenceService: PresenceService;
  readonly appEndpointRegistry: AppEndpointRegistry;
  readonly leaseRegistry: LeaseRegistry;
  readonly messageService: MessageService;
  readonly taskService: TaskService;
  readonly encryption: EnvelopeEncryption | null;
}

export const resolveServices = Effect.all({
  db: DbTag,
  encryption: EncryptionTag,
  connections: ConnectionManagerTag,
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  appAuthService: AppAuthServiceTag,
  conversationService: ConversationServiceTag,
  contactService: ContactsServiceTag,
  presenceService: PresenceServiceTag,
  appEndpointRegistry: AppEndpointRegistryTag,
  leaseRegistry: LeaseRegistryTag,
  messageService: MessageServiceTag,
  taskService: TaskServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
