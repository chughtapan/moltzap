/** @file Narrow core wiring barrel for server-core internals. */

export { createCoreApp, ServerBootFailedError } from "./app.js";
export { serverHandlers } from "./handler-catalog.js";
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
  DispatchAdmissionServiceTag,
  EncryptionTag,
  LeaseRegistryTag,
  MessageServiceTag,
  NetworkSendServiceTag,
  PresenceServiceLive,
  PresenceServiceTag,
  ServicesLive,
  TaskAuthorizationServiceTag,
  TaskServiceTag,
  resolveServices,
} from "./layers.js";
export type { ResolvedServices } from "./layers.js";

export { agentArm, appArm } from "./handler-runtime.js";

export type { AgentId, CoreApp, DisconnectionHook, UserId } from "./types.js";
