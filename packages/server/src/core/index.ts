/** @file Narrow core wiring barrel for server-core internals. */

export {
  AgentEndpointResolverTag,
  AppAuthServiceTag,
  AppHostTag,
  AuthServiceTag,
  ConnectionHooksTag,
  ConnectionManagerTag,
  ConnectionTag,
  ContactsServiceTag,
  ConversationServiceTag,
  DbTag,
  EncryptionTag,
  LeaseRegistryTag,
  MessageServiceTag,
  NetworkSendServiceTag,
  PresenceServiceLive,
  PresenceServiceTag,
  ServicesLive,
  TaskServiceTag,
  resolveServices,
} from "./layers.js";
export type { ResolvedServices } from "./layers.js";

export { agentArm, appArm } from "./handler-runtime.js";

export type {
  AgentId,
  CoreApp,
  MessageAuthorizeContext,
  UserId,
} from "./types.js";
